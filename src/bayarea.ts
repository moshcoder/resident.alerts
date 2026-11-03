/**
 * Santa Clara County and the South Bay. No agency here publishes a live 911
 * feed we can read, so this is the next best set, all public and keyless:
 *
 * - Palo Alto PD's own calls-for-service map layer (live, 0-24 h)
 * - PG&E outages (live: the whole current list on every read)
 * - Caltrans District 4 lane closures that are in effect now (live)
 * - Nixle alerts from the county's police departments and towns (no coordinates:
 *   pinned at the agency, and said so)
 * - Santa Clara County Sheriff calls (a daily batch, a few hours to a day late;
 *   block addresses, geocoded)
 */
import { createHash } from 'node:crypto'
import { blockAddress, type Geocoder, type Place } from './geocode.js'
import { getJson, toIncident, valid, type Incident, type Kind, type Source } from './sources.js'

const UA = 'resident.alerts/0.1 (+https://resident.alerts.pit.world; alerts@pit.world)'
const HOUR = 3600_000
const hash = (...parts: unknown[]) => createHash('sha1').update(parts.join('|')).digest('hex').slice(0, 16)
const round = (n: number) => Math.round(n * 1e6) / 1e6

async function getText(f: typeof fetch, url: string): Promise<string> {
  const r = await f(url, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(30_000) })
  if (!r.ok) throw new Error(`${new URL(url).host} said ${r.status}`)
  return r.text()
}

const ENT: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }
const unxml = (s: string) => String(s ?? '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/&(#\d+|[a-z]+);/gi, (m, e: string) => (e[0] === '#' ? String.fromCharCode(Number(e.slice(1))) : ENT[e.toLowerCase()] ?? m)).trim()
const tag = (xml: string, name: string) => unxml(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, 'i').exec(xml)?.[1] ?? '')
const plain = (html: string) => unxml(unxml(html).replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim()

/** Centre of an ArcGIS polygon's first ring (Palo Alto draws each call as a small circle). */
export function ringCentre(rings: number[][][] | undefined): [number, number] | null {
  const ring = rings?.[0]
  if (!ring?.length) return null
  let x = 0
  let y = 0
  for (const [lon, lat] of ring) {
    x += lon!
    y += lat!
  }
  return [y / ring.length, x / ring.length]
}

// ---- Palo Alto PD ---------------------------------------------------------------

const PA = 'https://gis.cityofpaloalto.org/server/rest/services/PublicSafety/AgencyCommonEvent/MapServer'

export function paloAltoRows(features: any[]) {
  return features.flatMap((ft) => {
    const a = ft?.attributes ?? {}
    const c = ringCentre(ft?.geometry?.rings) ?? [Number(ft?.geometry?.y), Number(ft?.geometry?.x)]
    if (!a.INCIDENTNUMBER || !valid(c[0], c[1])) return []
    return [{
      ext: String(a.INCIDENTNUMBER),
      type: String(a.CALLTYPEDESCRIPTION || a.CALLTYPE || ''),
      address: String(a.CROSSSTREET ?? '').replace(/\s*\/\s*/g, ' / '),
      time: Number(a.CALLTIME),
      lat: c[0],
      lon: c[1],
      detail: a.INCIDENTSTATUS ? `Status: ${String(a.INCIDENTSTATUS).toLowerCase()}` : '',
    }]
  })
}

export const PALO_ALTO_PD: Source = {
  id: 'paloalto-police',
  name: 'Palo Alto Police calls for service',
  area: 'Palo Alto, CA',
  center: [37.42, -122.14],
  km: 12,
  kinds: ['police', 'traffic', 'medical', 'other'],
  everyMs: 5 * 60_000,
  homepage: 'https://www.paloalto.gov/Departments/Police',
  async read(f) {
    const since = Date.now() - 24 * HOUR
    const out: Incident[] = []
    // Layer 1 is the last four hours, layer 2 four to 24.
    for (const layer of [1, 2]) {
      const r = await getJson(f, `${PA}/${layer}/query?where=1%3D1&outFields=*&outSR=4326&f=json`)
      for (const row of paloAltoRows(r?.features ?? [])) {
        const i = toIncident(this, row, 'America/Los_Angeles', since, 'police')
        if (i) out.push(i)
      }
    }
    return out
  },
}

// ---- PG&E outages ---------------------------------------------------------------

/** South Bay and the Santa Cruz Mountains. */
const SOUTH_BAY = { s: 36.9, w: -122.3, n: 37.6, e: -121.4 }

export function pgeIncidents(src: Pick<Source, 'id' | 'area' | 'homepage'>, features: any[]): Incident[] {
  return features.flatMap((ft) => {
    const a = ft?.attributes ?? {}
    const lat = Number(ft?.geometry?.y)
    const lon = Number(ft?.geometry?.x)
    if (!a.OUTAGE_ID || !valid(lat, lon)) return []
    const n = Number(a.EST_CUSTOMERS) || 0
    const etor = Number(a.CURRENT_ETOR)
    const restore = Number.isFinite(etor) && etor > 0 ? `Estimated restoration ${new Date(etor).toLocaleString('en-US', { timeZone: 'America/Los_Angeles', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}` : ''
    return [{
      id: `${src.id}:${a.OUTAGE_ID}`,
      source: src.id,
      kind: 'hazard' as Kind,
      severity: (n >= 1000 ? 3 : n >= 100 ? 2 : 1) as 1 | 2 | 3,
      title: `Power outage${n ? `: ${n.toLocaleString('en-US')} customer${n === 1 ? '' : 's'}` : ''}`,
      detail: [a.OUTAGE_CAUSE && `Cause: ${String(a.OUTAGE_CAUSE).toLowerCase()}`, a.CREW_CURRENT_STATUS, restore].filter(Boolean).join(' · '),
      address: '',
      area: src.area,
      lat: round(lat),
      lon: round(lon),
      at: Number(a.OUTAGE_START) || Date.now(),
      url: src.homepage,
    }]
  })
}

export const PGE_OUTAGES: Source = {
  id: 'pge-outages',
  name: 'PG&E power outages',
  area: 'South Bay, CA (PG&E)',
  center: [37.25, -121.9],
  km: 45,
  kinds: ['hazard'],
  everyMs: 5 * 60_000,
  homepage: 'https://pgealerts.alerts.pge.com/outagecenter/',
  live: true,
  async read(f) {
    const box = `${SOUTH_BAY.w},${SOUTH_BAY.s},${SOUTH_BAY.e},${SOUTH_BAY.n}`
    const r = await getJson(f, `https://ags.pge.esriemcs.com/arcgis/rest/services/43/outages/MapServer/4/query?where=1%3D1&geometry=${box}&geometryType=esriGeometryEnvelope&inSR=4326&spatialRel=esriSpatialRelIntersects&outFields=*&outSR=4326&f=json`)
    return pgeIncidents(this, r?.features ?? [])
  },
}

// ---- Caltrans District 4 lane closures ------------------------------------------

const BAY_COUNTIES = new Set(['Santa Clara', 'San Mateo', 'Alameda', 'Santa Cruz'])

export function closures(src: Pick<Source, 'id' | 'homepage'>, data: any[], now = Date.now()): Incident[] {
  return data.flatMap((d) => {
    const c = d?.lcs
    const b = c?.location?.begin ?? {}
    const t = c?.closure?.closureTimestamp ?? {}
    if (!BAY_COUNTIES.has(b.beginCounty)) return []
    const start = Number(t.closureStartEpoch) * 1000
    const end = t.isClosureEndIndefinite === 'true' ? Infinity : Number(t.closureEndEpoch) * 1000
    // In effect now, and not already picked up (10-98).
    if (!(start <= now && now < end) || c.closure?.code1098?.isCode1098 === 'true') return []
    const lat = Number(b.beginLatitude)
    const lon = Number(b.beginLongitude)
    if (!valid(lat, lon)) return []
    const e = c.location?.end ?? {}
    const full = /full/i.test(c.closure.typeOfClosure ?? '')
    const dir = c.location.travelFlowDirection ? `${c.location.travelFlowDirection}bound ` : ''
    return [{
      id: `${src.id}:${c.index}`,
      source: src.id,
      kind: 'traffic' as Kind,
      severity: (full ? 2 : 1) as 1 | 2 | 3,
      title: `${b.beginRoute} ${full ? 'closed' : 'lane closure'}`.trim(),
      detail: [`${dir}${c.closure.typeOfClosure}`, c.closure.lanesClosed && `lanes ${c.closure.lanesClosed}`, c.closure.typeOfWork, Number.isFinite(end) && `until ${new Date(end).toLocaleString('en-US', { timeZone: 'America/Los_Angeles', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}`].filter(Boolean).join(' · '),
      address: [b.beginLocationName, e.endLocationName].filter(Boolean).join(' to '),
      area: `${b.beginNearbyPlace || b.beginCounty}, CA (Caltrans)`,
      lat: round(lat),
      lon: round(lon),
      at: start,
      url: src.homepage,
    }]
  })
}

export const CALTRANS_D4: Source = {
  id: 'caltrans-d4',
  name: 'Caltrans lane closures (District 4)',
  area: 'South Bay, CA (Caltrans)',
  center: [37.3, -121.95],
  km: 70,
  kinds: ['traffic'],
  everyMs: 10 * 60_000,
  homepage: 'https://quickmap.dot.ca.gov/',
  live: true,
  async read(f) {
    const r = await getJson(f, 'https://cwwp2.dot.ca.gov/data/d4/lcs/lcsStatusD04.json')
    return closures(this, r?.data ?? [])
  },
}

// ---- Nixle ----------------------------------------------------------------------

/** Agencies with a Nixle feed that still posts (checked 2026-11-03), and where to pin them. */
export const NIXLE_AGENCIES: { id: number; name: string; at: [number, number] }[] = [
  { id: 18939, name: 'Town of Los Gatos', at: [37.2266, -121.9747] },
  { id: 13251, name: 'Campbell Police', at: [37.2872, -121.95] },
  { id: 2446, name: 'Sunnyvale Public Safety', at: [37.3688, -122.0363] },
  { id: 13615, name: 'Santa Clara Police', at: [37.3541, -121.9552] },
  { id: 11120, name: 'Palo Alto Police', at: [37.4419, -122.143] },
  { id: 12578, name: 'Gilroy Police', at: [37.0058, -121.5683] },
  { id: 12677, name: 'Morgan Hill Police', at: [37.1305, -121.6544] },
]

export function nixleItems(src: Pick<Source, 'id'>, agency: (typeof NIXLE_AGENCIES)[number], xml: string, since: number): Incident[] {
  return (xml.match(/<item>[\s\S]*?<\/item>/g) ?? []).flatMap((item) => {
    const title = tag(item, 'title')
    const link = tag(item, 'link')
    const at = Date.parse(tag(item, 'pubDate'))
    if (!title || !Number.isFinite(at) || at < since) return []
    const text = plain(tag(item, 'description')).slice(0, 600)
    const kind: Kind = /fire|smoke|burn/i.test(title) ? 'fire' : /road|traffic|closure|collision|crash|lane/i.test(title) ? 'traffic' : /storm|flood|heat|wind|weather|outage|power|water|main break|gas leak|sewer|boil/i.test(title) ? 'hazard' : 'police'
    return [{
      id: `${src.id}:${agency.id}:${/alert\/(\d+)/.exec(link)?.[1] ?? hash(title, at)}`,
      source: src.id,
      kind,
      severity: (/urgent|emergency|evacuat|shelter in place|active shooter|missing/i.test(title) ? 2 : 1) as 1 | 2 | 3,
      title,
      detail: `${agency.name} alert (pinned at the agency, not the scene). ${text}`.trim(),
      address: '',
      area: `${agency.name} (Nixle)`,
      lat: agency.at[0],
      lon: agency.at[1],
      at,
      url: link || `https://local.nixle.com/`,
    }]
  })
}

export const NIXLE_SCC: Source = {
  id: 'nixle-scc',
  name: 'Police and town alerts (Nixle)',
  area: 'Santa Clara County, CA',
  center: [37.3, -121.95],
  km: 50,
  kinds: ['police', 'traffic', 'hazard', 'fire'],
  everyMs: 15 * 60_000,
  homepage: 'https://local.nixle.com/',
  async read(f) {
    const since = Date.now() - 7 * 24 * HOUR
    const out: Incident[] = []
    for (const a of NIXLE_AGENCIES) {
      try {
        out.push(...nixleItems(this, a, await getText(f, `https://rss.nixle.com/pubs/feeds/latest/${a.id}/`), since))
      } catch (e) {
        console.warn(`[nixle] ${a.name}: ${(e as Error).message}`)
      }
    }
    return out
  },
}

// ---- Santa Clara County Sheriff (daily) -----------------------------------------

/** The Sheriff's `city` is always the county, so geocode by street inside the county. */
const SCC: Place = { city: '', state: 'CA', bbox: [36.89, -122.21, 37.49, -121.2] }

export const SCC_SHERIFF: Source = {
  id: 'scc-sheriff',
  name: 'Santa Clara County Sheriff calls (daily)',
  area: 'Santa Clara County, CA (Sheriff)',
  center: [37.25, -121.95],
  km: 50,
  kinds: ['police', 'medical', 'traffic', 'other'],
  everyMs: 60 * 60_000,
  homepage: 'https://data.sccgov.org/Public-Safety/Crime-Reports/n9u6-aijz',
  async read(f, geo?: Geocoder) {
    // Published once a day, so look back two days.
    const since = Date.now() - 48 * HOUR
    const sinceText = new Date(since - 24 * HOUR).toISOString().slice(0, 19)
    const rows: any[] = await getJson(f, `https://data.sccgov.org/resource/n9u6-aijz.json?$limit=500&$order=${encodeURIComponent('incident_datetime DESC')}&$where=${encodeURIComponent(`incident_datetime > '${sinceText}' AND address_1 IS NOT NULL`)}`)
    const out: Incident[] = []
    for (const r of rows) {
      const street = blockAddress(String(r.address_1 ?? ''))
      if (!street || !geo) continue
      const p = await geo.address(street, SCC)
      if (!p) continue
      const i = toIncident(this, { ext: String(r.case_number), type: String(r.incident_type_primary ?? ''), address: String(r.address_1), time: String(r.incident_datetime), lat: p.lat, lon: p.lon, detail: 'Reported to the Sheriff; published a day later.' }, 'America/Los_Angeles', since, 'police')
      if (i) out.push(i)
    }
    return out
  },
}

export const BAY_AREA_SOURCES = [PALO_ALTO_PD, PGE_OUTAGES, CALTRANS_D4, NIXLE_SCC, SCC_SHERIFF]
