/**
 * Every feed we read, in one list. The generic adapters live in sources.ts;
 * the ones here each have a format of their own (a JSON file, an XML list, an
 * RSS feed, an HTML table), and three of them publish addresses without
 * coordinates, so they go through the geocoder.
 */
import { createHash } from 'node:crypto'
import { blockAddress, streetName, type Geocoder, type Place } from './geocode.js'
import { EVACUATIONS, WILDFIRES } from './wildfire.js'
import { getJson, NWS, num, SEATTLE_FIRE, SF_POLICE, socrata, toIncident, USGS, valid, type Incident, type Kind, type Row, type Source } from './sources.js'

const UA = 'resident.alerts/0.1 (+https://resident.alerts.pit.world; alerts@pit.world)'
const HOUR = 3600_000
const hash = (...parts: unknown[]) => createHash('sha1').update(parts.join('|')).digest('hex').slice(0, 16)

async function getText(f: typeof fetch, url: string): Promise<string> {
  const r = await f(url, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(20_000) })
  if (!r.ok) throw new Error(`${new URL(url).host} said ${r.status}`)
  return r.text()
}

const ENT: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }
export const unxml = (s: string) => String(s ?? '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/&(#\d+|[a-z]+);/gi, (m, e: string) => (e[0] === '#' ? String.fromCharCode(Number(e.slice(1))) : ENT[e.toLowerCase()] ?? m)).trim()
const tag = (xml: string, name: string) => unxml(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, 'i').exec(xml)?.[1] ?? '')

/** "10/25/2026 9:02:22 PM" or "10/25/2026 22:22" -> "2026-10-25T21:02:22" (still wall-clock). */
export function mdy(text: string): string {
  const m = /(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?/i.exec(String(text ?? ''))
  if (!m) return ''
  let h = Number(m[4])
  if (m[7]) h = (h % 12) + (/pm/i.test(m[7]) ? 12 : 0)
  const p = (n: number | string) => String(n).padStart(2, '0')
  return `${m[3]}-${p(m[1]!)}-${p(m[2]!)}T${p(h)}:${m[5]}:${m[6] ?? '00'}`
}

/** A dispatch location that may be "123 BLOCK MAIN ST", "A ST / B AVE" or a street plus a cross street. */
export async function locate(geo: Geocoder | undefined, place: Place, address: string, cross = ''): Promise<{ lat: number; lon: number } | null> {
  if (!geo) return null
  const parts = String(address ?? '').split(/\s*(?:\/|&| and | at )\s*/i).filter(Boolean)
  const block = blockAddress(parts[0] ?? '')
  if (block && parts.length === 1) return geo.address(block, place)
  const a = streetName(parts[0] ?? '')
  const crossFirst = parts[1] ?? String(cross ?? '').split(/\s*[/&]\s*/)[0] ?? ''
  const b = streetName(crossFirst)
  if (a && b && a !== b) return geo.corner(a, b, place)
  return null
}

/** "LOUISIANA ST" + "BLK HADLEY ST" -> "LOUISIANA ST / HADLEY ST" (what we show, and what locate() splits). */
export const withCross = (address: string, cross: string) => {
  const c = String(cross ?? '').replace(/^\s*(BLK|BLOCK)\s+/i, '').trim()
  return c && streetName(c) && !/\//.test(address) && !/&/.test(address) ? `${address.trim()} / ${c}` : address.trim()
}

/** Rows that need a geocode: look them up (politely), keep the ones we could place. */
async function placed(geo: Geocoder | undefined, src: { id: string; area: string; homepage: string }, place: Place, tz: string, since: number, rows: (Row & { cross?: string; fallback?: Kind })[]): Promise<Incident[]> {
  const out: Incident[] = []
  for (const r of rows) {
    const p = Number.isFinite(r.lat) ? { lat: r.lat, lon: r.lon } : await locate(geo, place, r.address, r.cross)
    if (!p) continue
    const i = toIncident(src, { ...r, lat: p.lat, lon: p.lon }, tz, since, r.fallback)
    if (i) out.push(i)
  }
  return out
}

// ---- Socrata, with coordinates -------------------------------------------------

const austin = (id: string, dataset: string, name: string, kinds: Kind[], fallback: Kind) =>
  socrata({
    id,
    name,
    area: 'Austin, TX',
    center: [30.27, -97.74],
    km: 30,
    kinds,
    host: 'datahub.austintexas.gov',
    dataset,
    order: 'published_date',
    tz: 'America/Chicago',
    homepage: `https://data.austintexas.gov/d/${dataset}`,
    fallback,
    row: (r) => ({ ext: r.traffic_report_id, type: r.issue_reported ?? '', address: r.address ?? '', time: r.published_date, lat: num(r.latitude), lon: num(r.longitude), detail: [r.agency && r.agency !== 'FIRE' ? String(r.agency).trim() : '', r.traffic_report_status === 'ACTIVE' ? 'active' : ''].filter(Boolean).join(' · ') }),
  })

export const AUSTIN_FIRE = austin('austin-fire', 'wpu4-x69d', 'Austin Fire real-time incidents', ['fire', 'medical', 'hazard'], 'fire')
export const AUSTIN_TRAFFIC = austin('austin-traffic', 'dx9v-zd7x', 'Austin police and traffic incidents', ['traffic', 'police', 'hazard'], 'traffic')

// ---- custom formats, with coordinates ----------------------------------------------

export const TULSA_FIRE: Source = {
  id: 'tulsa-fire',
  name: 'Tulsa Fire dispatch',
  area: 'Tulsa, OK',
  center: [36.15, -95.99],
  km: 25,
  kinds: ['fire', 'medical', 'traffic'],
  everyMs: 2 * 60_000,
  homepage: 'https://www.cityoftulsa.org/government/departments/information-technology/open-data/',
  async read(f) {
    const doc = await getJson(f, 'https://www.cityoftulsa.org/apps/opendata/tfd_dispatch.jsn')
    const list: any[] = [doc?.Incidents?.Incident ?? []].flat()
    const since = Date.now() - 24 * HOUR
    return list.flatMap((r) => {
      const units = [r?.Vehicles?.Vehicle ?? []].flat().map((v: any) => v?.VehicleID).filter(Boolean)
      return toIncident(this, { ext: r.IncidentNumber, type: r.Problem ?? '', address: r.Address ?? '', time: mdy(r.ResponseDate), lat: num(r.Latitude), lon: num(r.Longitude), detail: units.length ? `Units: ${units.join(', ')}` : '' }, 'America/Chicago', since, 'fire') ?? []
    })
  },
}

export const MONROE_NY: Source = {
  id: 'monroe-ny',
  name: 'Monroe County 911 (Rochester)',
  area: 'Rochester, NY',
  center: [43.16, -77.61],
  km: 35,
  kinds: ['police', 'fire', 'medical', 'traffic'],
  everyMs: 2 * 60_000,
  homepage: 'https://www.monroecounty.gov/safety-incidents',
  async read(f) {
    const xml = await getText(f, 'https://www.monroecounty.gov/incidents911.rss')
    const since = Date.now() - 24 * HOUR
    const out: Incident[] = []
    for (const item of xml.split(/<item>/i).slice(1)) {
      const title = tag(item, 'title')
      const at = / at (.+)$/i.exec(title)
      const ext = /ID:\s*([A-Z0-9-]+)/i.exec(tag(item, 'description'))?.[1] ?? tag(item, 'guid')
      const status = /Status:\s*([A-Z ]+)/i.exec(tag(item, 'description'))?.[1]?.trim() ?? ''
      const i = toIncident(this, {
        ext,
        type: at ? title.slice(0, at.index) : title,
        address: (at?.[1] ?? '').replace(/\s+[A-Z]{3,4}$/, ''),
        time: tag(item, 'pubDate'),
        lat: num(tag(item, 'geo:lat')),
        lon: num(tag(item, 'geo:long')),
        detail: status ? status.toLowerCase().replace('onscene', 'on scene') : '',
      }, 'America/New_York', since)
      if (i) out.push(i)
    }
    return out
  },
}

// ---- addresses only (geocoded) ------------------------------------------------

const SAN_DIEGO: Place = { city: 'San Diego', state: 'CA', bbox: [32.53, -117.31, 33.12, -116.9] }
export const SAN_DIEGO_FIRE: Source = {
  id: 'sandiego-fire',
  name: 'San Diego Fire-Rescue dispatch',
  area: 'San Diego, CA',
  center: [32.75, -117.15],
  km: 30,
  kinds: ['fire', 'medical', 'traffic'],
  everyMs: 2 * 60_000,
  homepage: 'https://webapps.sandiego.gov/sdfiredispatch/',
  async read(f, geo) {
    const list: any[] = await getJson(f, 'https://webapps.sandiego.gov/sdfiredispatch/api/v1/Incidents')
    const rows = list.map((r) => ({
      ext: hash(r.ResponseDate, String(r.Address).trim(), r.CallType),
      type: r.CallType ?? '',
      address: withCross(String(r.Address ?? '').trim(), String(r.CrossStreet ?? '').split('/')[0] ?? ''),
      cross: '',
      time: r.ResponseDate,
      lat: NaN,
      lon: NaN,
      detail: r.UnitName ? `Units: ${r.UnitName}` : '',
      fallback: 'fire' as Kind,
    }))
    return placed(geo, this, SAN_DIEGO, 'America/Los_Angeles', Date.now() - 24 * HOUR, rows)
  },
}

const ORLANDO: Place = { city: 'Orlando', state: 'FL', bbox: [28.34, -81.52, 28.65, -81.19] }
export const ORLANDO_POLICE: Source = {
  id: 'orlando-police',
  name: 'Orlando Police active calls',
  area: 'Orlando, FL',
  center: [28.54, -81.38],
  km: 20,
  kinds: ['police', 'traffic'],
  everyMs: 2 * 60_000,
  homepage: 'https://www1.cityoforlando.net/opd/activecalls/activecadpolice.xml',
  async read(f, geo) {
    const xml = await getText(f, 'https://www1.cityoforlando.net/opd/activecalls/activecadpolice.xml')
    const rows = [...xml.matchAll(/<CALL incident="([^"]+)">([\s\S]*?)<\/CALL>/gi)].map((m) => ({
      ext: m[1]!,
      type: tag(m[2]!, 'DESC'),
      address: tag(m[2]!, 'LOCATION'),
      time: mdy(tag(m[2]!, 'DATE')),
      lat: NaN,
      lon: NaN,
      detail: tag(m[2]!, 'DISTRICT') ? `District ${tag(m[2]!, 'DISTRICT')}` : '',
      fallback: 'police' as Kind,
    }))
    return placed(geo, this, ORLANDO, 'America/New_York', Date.now() - 24 * HOUR, rows)
  },
}

const HOUSTON: Place = { city: 'Houston', state: 'TX', bbox: [29.5, -95.82, 30.15, -95.0] }
/** Houston's combined HFD + HPD active incidents page: an HTML table, refreshed every few minutes. */
export function houstonRows(html: string) {
  const table = /<table[^>]*id="GridView2"[\s\S]*?<\/table>/i.exec(html)?.[0] ?? ''
  return [...table.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)]
    .map((m) => [...m[1]!.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((c) => unxml(c[1]!.replace(/<[^>]+>/g, ''))))
    .filter((c) => c.length >= 6)
    .map(([agency, address, cross, keymap, time, type]) => ({
      ext: hash(agency, address, cross, time, type),
      type: String(type ?? '').replace(/\*+$/, ''),
      address: withCross(address ?? '', cross ?? ''),
      cross: '',
      time: mdy(time ?? ''),
      lat: NaN,
      lon: NaN,
      detail: [agency === 'PD' ? 'Houston Police' : 'Houston Fire', keymap ? `Key Map ${keymap}` : ''].filter(Boolean).join(' · '),
      fallback: (agency === 'PD' ? 'police' : 'fire') as Kind,
    }))
}
export const HOUSTON_ACTIVE: Source = {
  id: 'houston',
  name: 'Houston Fire and Police active incidents',
  area: 'Houston, TX',
  center: [29.76, -95.37],
  km: 35,
  kinds: ['police', 'fire', 'medical', 'traffic'],
  everyMs: 3 * 60_000,
  homepage: 'https://cohweb.houstontx.gov/ActiveIncidents/Combined.aspx',
  async read(f, geo) {
    const html = await getText(f, 'https://cohweb.houstontx.gov/ActiveIncidents/Combined.aspx')
    return placed(geo, this, HOUSTON, 'America/Chicago', Date.now() - 24 * HOUR, houstonRows(html))
  },
}

export const SOURCES: Source[] = [
  SEATTLE_FIRE,
  SF_POLICE,
  AUSTIN_FIRE,
  AUSTIN_TRAFFIC,
  TULSA_FIRE,
  MONROE_NY,
  HOUSTON_ACTIVE,
  SAN_DIEGO_FIRE,
  ORLANDO_POLICE,
  NWS,
  USGS,
  WILDFIRES,
  EVACUATIONS,
]

export const sourceById = (id: string) => SOURCES.find((s) => s.id === id)
/** The city feeds (not the nationwide ones), for the coverage list. */
export const CITY_SOURCES = SOURCES.filter((s) => s.km < 1000)
