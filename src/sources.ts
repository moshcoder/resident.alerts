/**
 * Where incidents come from: public 911 / dispatch feeds that cities publish
 * themselves, plus the National Weather Service and USGS for the whole country.
 *
 * Every source turns its own rows into the same Incident shape. Socrata feeds
 * write local wall-clock time with no zone ("2026-10-25T19:16:00.000"), so each
 * one names its time zone and `zoned()` turns that into a real instant.
 *
 * We read these on the server and keep them in our own database, so a visitor
 * never talks to a city's portal and a city sees one polite client, not
 * thousands of phones.
 */

import type { Geocoder } from './geocode.js'

export type Kind = 'police' | 'fire' | 'medical' | 'traffic' | 'weather' | 'quake' | 'hazard' | 'other'
export const KINDS: Kind[] = ['police', 'fire', 'medical', 'traffic', 'weather', 'quake', 'hazard', 'other']

export type Incident = {
  /** `<source>:<their id>`, stable across reads. */
  id: string
  source: string
  kind: Kind
  /** 1 routine, 2 notable, 3 serious (shots, structure fire, tornado warning). */
  severity: 1 | 2 | 3
  title: string
  detail: string
  address: string
  area: string
  lat: number
  lon: number
  /** When it was reported (ms). */
  at: number
  url: string
  /** NWS polygons, as [lat, lon] rings, so the map can draw the warned area. */
  shape?: [number, number][][]
}

export type Source = {
  id: string
  name: string
  area: string
  /** Map centre and roughly how far the feed reaches, for the coverage list. */
  center: [number, number]
  km: number
  kinds: Kind[]
  everyMs: number
  homepage: string
  read: (f: typeof fetch, geo?: Geocoder) => Promise<Incident[]>
}

const UA = 'resident.alerts/0.1 (+https://resident.alerts.pit.world; alerts@pit.world)'

export async function getJson(f: typeof fetch, url: string, headers: Record<string, string> = {}): Promise<any> {
  const r = await f(url, { headers: { 'user-agent': UA, accept: 'application/json, application/geo+json', ...headers }, signal: AbortSignal.timeout(20_000) })
  if (!r.ok) throw new Error(`${new URL(url).host} said ${r.status}`)
  return r.json()
}

const wallClock = (tz: string, at: number) => {
  const p: Record<string, string> = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
      .formatToParts(new Date(at))
      .map((x) => [x.type, x.value]),
  )
  const n = (k: string) => Number(p[k] ?? 0)
  return Date.UTC(n('year'), n('month') - 1, n('day'), n('hour'), n('minute'), n('second'))
}

/** "2026-10-25T19:16:00.000" in America/Los_Angeles -> epoch ms. */
export function zoned(local: string, tz: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?/.exec(local ?? '')
  if (!m) return NaN
  const asUtc = Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, +(m[6] ?? 0))
  // The zone's wall clock at that instant tells us the offset; a second pass settles DST edges.
  const guess = asUtc - (wallClock(tz, asUtc) - asUtc)
  return guess + (asUtc - wallClock(tz, guess))
}

const SMALL = new Set(['a', 'an', 'and', 'at', 'by', 'for', 'in', 'of', 'on', 'or', 'the', 'to', 'with'])
/** "SUSPICIOUS PERSON / VEHICLE" -> "Suspicious person / vehicle". Mixed-case text is left alone. */
export function tidy(text: string): string {
  const t = String(text ?? '').replace(/\s+/g, ' ').trim()
  if (!t || t !== t.toUpperCase()) return t
  return t
    .toLowerCase()
    .split(' ')
    .map((w, i) => (i === 0 ? w.charAt(0).toUpperCase() + w.slice(1) : SMALL.has(w) ? w : /^\d|^[a-z]\d/.test(w) ? w.toUpperCase() : w))
    .join(' ')
}

const titleWord = (w: string) => (/^\d+(st|nd|rd|th)$/i.test(w) ? w.toLowerCase() : /^\d/.test(w) ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
/** Address text as people say it: "BEACH ST \ GRANT AVE" -> "Beach St & Grant Ave". */
export function tidyAddress(text: string): string {
  const t = String(text ?? '').replace(/\s*[\\/]\s*/g, ' & ').replace(/\s+/g, ' ').trim()
  if (!t || t !== t.toUpperCase()) return t
  return t.split(' ').map((w) => (w === '&' ? w : /^(blk|block)$/i.test(w) ? 'block' : titleWord(w))).join(' ')
}

const RULES: [RegExp, Kind, 1 | 2 | 3][] = [
  [/shoot|shots? fired|shot ?spotter|gunshot|person shot|homicide|stabb|active (shooter|threat)|man with a gun|hostage|kidnap|carjack|bomb threat|explosive device/i, 'police', 3],
  [/(structure|building|house|apartment|commercial|residential|working|2-alarm|3-alarm|multiple alarm) fire|fire.*(structure|building|residential|commercial)|explosion|hazmat|haz-mat|gas leak|natural gas/i, 'fire', 3],
  [/tornado|tsunami|hurricane|extreme wind|flash flood warning/i, 'weather', 3],
  [/collision|crash|mva|mvc|accident|hit and run|rollover|pedestrian struck|traffic|motor vehicle|road(way)? blocked|stalled|vehicle into/i, 'traffic', 2],
  [/robbery|burglary|assault|battery|fight|weapon|armed|prowler|break[- ]?in|domestic|threat|shoplift|theft|stolen|vandal|trespass|suspicious|disturbance|police|welfare check|missing|drunk|noise|burglar alarm|panic alarm|hold-?up/i, 'police', 2],
  [/fire|smoke|burn|brush|vegetation|alarm|odor|wires down|electrical/i, 'fire', 2],
  [/\baid\b|medic|medical|\bems\b|ambulance|overdose|cardiac|breathing|unconscious|injur|\bfall|sick|seizure|stroke|bleeding|chest pain|\bcpr\b|rescue/i, 'medical', 1],
  [/\b(flood|storm|wind|winter|snow|ice|heat|freeze|frost|fog|fire weather|red flag|air quality|thunder)/i, 'weather', 2],
  [/hazard|spill|leak|downed|tree down|power outage/i, 'hazard', 1],
]

/** A best guess at what kind of call this is, from its type text. */
export function classify(text: string, fallback: Kind = 'other'): { kind: Kind; severity: 1 | 2 | 3 } {
  for (const [re, kind, severity] of RULES) if (re.test(text)) return { kind, severity }
  return { kind: fallback, severity: 1 }
}

export const num = (v: unknown) => (v === null || v === undefined || v === '' ? NaN : Number(v))
export const valid = (lat: number, lon: number) => Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) > 0.5 && Math.abs(lon) > 0.5 && Math.abs(lat) <= 90 && Math.abs(lon) <= 180

export type Row = { ext: string; type: string; address: string; time: string | number; lat: number; lon: number; detail?: string }

type SocrataSpec = {
  id: string
  name: string
  area: string
  center: [number, number]
  km: number
  kinds: Kind[]
  host: string
  dataset: string
  /** The timestamp column; rows come newest first by it. */
  order: string
  /** Zone of the floating timestamps. */
  tz: string
  homepage: string
  fallback?: Kind
  /** Only rows reported in the last `hours` (default 24) are kept. */
  hours?: number
  where?: string
  row: (r: any) => Row | null
}

/** One row of any feed -> an Incident, or null if it has no place or time we can use. */
export function toIncident(source: { id: string; area: string; homepage: string }, r: Row | null, tz: string, sinceMs: number, fallback: Kind = 'other'): Incident | null {
  if (!r || !r.ext || !valid(r.lat, r.lon)) return null
  // A timestamp that names its own zone ("…Z", "…-07:00", RFC 822) is parsed as is; bare wall-clock text is the feed's zone.
  const at = typeof r.time === 'number' ? r.time : /(Z|[+-]\d\d:?\d\d|GMT|[ECMP][SD]T)$/.test(String(r.time).trim()) ? Date.parse(r.time) : zoned(r.time, tz)
  if (!Number.isFinite(at) || at < sinceMs || at > Date.now() + 3600_000) return null
  const c = classify(r.type, fallback)
  return {
    id: `${source.id}:${r.ext}`,
    source: source.id,
    kind: c.kind,
    severity: c.severity,
    title: tidy(r.type) || 'Incident',
    detail: r.detail ?? '',
    address: tidyAddress(r.address),
    area: source.area,
    lat: Math.round(r.lat * 1e6) / 1e6,
    lon: Math.round(r.lon * 1e6) / 1e6,
    at,
    url: source.homepage,
  }
}

/** A Socrata (SODA) dataset: newest rows first, the last day only. */
export function socrata(s: SocrataSpec): Source {
  return {
    id: s.id,
    name: s.name,
    area: s.area,
    center: s.center,
    km: s.km,
    kinds: s.kinds,
    everyMs: 2 * 60_000,
    homepage: s.homepage,
    async read(f) {
      const since = Date.now() - (s.hours ?? 24) * 3600_000
      // Floating timestamps compare as wall-clock text; a day of slack covers any zone.
      const sinceText = new Date(since - 24 * 3600_000).toISOString().slice(0, 19)
      const where = [`${s.order} > '${sinceText}'`, s.where].filter(Boolean).join(' AND ')
      const url = `https://${s.host}/resource/${s.dataset}.json?$limit=1000&$order=${encodeURIComponent(`${s.order} DESC`)}&$where=${encodeURIComponent(where)}`
      const rows: any[] = await getJson(f, url)
      return rows.flatMap((raw) => toIncident(s, s.row(raw), s.tz, since, s.fallback) ?? [])
    },
  }
}

export const point = (p: any): [number, number] => {
  const c = p?.coordinates
  return Array.isArray(c) ? [num(c[1]), num(c[0])] : [num(p?.latitude), num(p?.longitude)]
}

export const SEATTLE_FIRE = socrata({
  id: 'seattle-fire',
  name: 'Seattle Fire 911 calls',
  area: 'Seattle, WA',
  center: [47.61, -122.33],
  km: 18,
  kinds: ['fire', 'medical', 'traffic', 'hazard'],
  host: 'data.seattle.gov',
  dataset: 'kzjm-xkqj',
  order: 'datetime',
  tz: 'America/Los_Angeles',
  homepage: 'https://data.seattle.gov/Public-Safety/Seattle-Real-Time-Fire-911-Calls/kzjm-xkqj',
  fallback: 'fire',
  row: (r) => ({ ext: r.incident_number, type: r.type ?? '', address: r.address ?? '', time: r.datetime, lat: num(r.latitude), lon: num(r.longitude) }),
})

export const SF_POLICE = socrata({
  id: 'sf-police',
  name: 'SFPD dispatched calls',
  area: 'San Francisco, CA',
  center: [37.76, -122.44],
  km: 12,
  kinds: ['police', 'traffic', 'medical'],
  host: 'data.sf.gov',
  dataset: 'gnap-fj3t',
  order: 'received_datetime',
  tz: 'America/Los_Angeles',
  homepage: 'https://data.sfgov.org/Public-Safety/Law-Enforcement-Dispatched-Calls-for-Service-Real-/gnap-fj3t',
  fallback: 'police',
  row: (r) => {
    // The city already withholds sensitive calls' details; we skip them entirely.
    if (r.sensitive_call === true) return null
    const [lat, lon] = point(r.intersection_point)
    const detail = [r.analysis_neighborhood, r.priority_final ? `priority ${r.priority_final}` : ''].filter(Boolean).join(' · ')
    return { ext: r.cad_number ?? r.id, type: r.call_type_final_desc || r.call_type_original_desc || '', address: r.intersection_name ?? '', time: r.received_datetime, lat, lon, detail }
  },
})

/** NWS alerts that carry their own polygon (warnings drawn by forecasters: tornado, flash flood, severe storm...). */
export const NWS: Source = {
  id: 'nws',
  name: 'National Weather Service warnings',
  area: 'United States',
  center: [39.5, -98.35],
  km: 2500,
  kinds: ['weather', 'hazard'],
  everyMs: 3 * 60_000,
  homepage: 'https://www.weather.gov/alerts',
  async read(f) {
    const doc = await getJson(f, 'https://api.weather.gov/alerts/active?status=actual&message_type=alert,update')
    const out: Incident[] = []
    for (const feat of doc?.features ?? []) {
      const p = feat.properties ?? {}
      const g = feat.geometry
      if (!g || (g.type !== 'Polygon' && g.type !== 'MultiPolygon')) continue
      const polys: number[][][][] = g.type === 'Polygon' ? [g.coordinates] : g.coordinates
      const rings = polys.map((poly) => poly[0]!.map(([lon, lat]) => [lat, lon] as [number, number]))
      const all = rings.flat()
      const lat = all.reduce((a, c) => a + c[0], 0) / all.length
      const lon = all.reduce((a, c) => a + c[1], 0) / all.length
      if (!valid(lat, lon)) continue
      const event = String(p.event ?? 'Weather alert')
      const severity: 1 | 2 | 3 = /warning/i.test(event) && /tornado|flash flood|extreme|hurricane|tsunami|severe thunderstorm|dust storm|snow squall/i.test(event) ? 3 : /warning/i.test(event) ? 2 : 1
      out.push({
        id: `nws:${p.id ?? feat.id}`,
        source: 'nws',
        kind: /fire weather|red flag/i.test(event) ? 'hazard' : 'weather',
        severity,
        title: event,
        detail: String(p.headline ?? '').slice(0, 300),
        address: String(p.areaDesc ?? '').slice(0, 200),
        area: String(p.senderName ?? 'NWS'),
        lat,
        lon,
        at: Date.parse(p.sent ?? p.effective) || Date.now(),
        url: `https://alerts.weather.gov/search?id=${encodeURIComponent(p.id ?? '')}`,
        shape: rings,
      })
    }
    return out
  },
}

export const USGS: Source = {
  id: 'usgs',
  name: 'USGS earthquakes (M2.5+)',
  area: 'Worldwide',
  center: [39.5, -98.35],
  km: 20000,
  kinds: ['quake'],
  everyMs: 2 * 60_000,
  homepage: 'https://earthquake.usgs.gov/earthquakes/map/',
  async read(f) {
    const doc = await getJson(f, 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/2.5_day.geojson')
    return (doc?.features ?? []).flatMap((feat: any): Incident[] => {
      const p = feat.properties ?? {}
      const [lon, lat] = feat.geometry?.coordinates ?? []
      if (!valid(num(lat), num(lon))) return []
      const mag = Number(p.mag ?? 0)
      return [{
        id: `usgs:${feat.id}`,
        source: 'usgs',
        kind: 'quake',
        severity: mag >= 5.5 || p.tsunami ? 3 : mag >= 4 ? 2 : 1,
        title: `M${mag.toFixed(1)} earthquake`,
        detail: p.tsunami ? 'Tsunami possible: check tsunami.gov' : p.felt ? `${p.felt} people reported feeling it` : '',
        address: String(p.place ?? ''),
        area: 'USGS',
        lat: num(lat),
        lon: num(lon),
        at: Number(p.time) || Date.now(),
        url: String(p.url ?? 'https://earthquake.usgs.gov'),
      }]
    })
  },
}

/** Great-circle distance in km. */
export function km(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const r = (d: number) => (d * Math.PI) / 180
  const dLat = r(bLat - aLat)
  const dLon = r(bLon - aLon)
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(r(aLat)) * Math.cos(r(bLat)) * Math.sin(dLon / 2) ** 2
  return 6371 * 2 * Math.asin(Math.min(1, Math.sqrt(h)))
}

/** Is the point inside any ring? (ray casting; rings are [lat, lon]) */
export function inShape(lat: number, lon: number, rings: [number, number][][]): boolean {
  for (const ring of rings) {
    let inside = false
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [yi, xi] = ring[i]!
      const [yj, xj] = ring[j]!
      if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside
    }
    if (inside) return true
  }
  return false
}
