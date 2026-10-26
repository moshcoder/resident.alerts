/**
 * Turning dispatch addresses into points, for the cities that publish calls
 * without coordinates (Houston, San Diego, Orlando).
 *
 * Two shapes show up:
 *   "5200 BLOCK INTERNATIONAL DR"      -> US Census geocoder (free, no key)
 *   "LOUISIANA ST" x "BLK HADLEY ST"   -> an intersection: we fetch each street's
 *                                         lines from OpenStreetMap (Nominatim) and
 *                                         find where they meet.
 *
 * Every answer, a miss included, is cached in SQLite, so a street is looked up
 * once, not once per call. Nominatim asks for at most one request a second and a
 * real User-Agent; one shared queue keeps us under that for the whole process.
 */
import type { Database } from 'bun:sqlite'

const UA = 'resident.alerts/0.1 (+https://resident.alerts.pit.world; alerts@pit.world)'
export type Point = { lat: number; lon: number }
type Line = [number, number][] // [lat, lon]
const OVER = Symbol('over budget')

const ABBR: Record<string, string> = {
  ST: 'Street', AVE: 'Avenue', AV: 'Avenue', BLVD: 'Boulevard', DR: 'Drive', RD: 'Road', LN: 'Lane', CT: 'Court', PL: 'Place', PKWY: 'Parkway',
  HWY: 'Highway', FWY: 'Freeway', EXPY: 'Expressway', TER: 'Terrace', CIR: 'Circle', WAY: 'Way', TRL: 'Trail', SQ: 'Square', PLZ: 'Plaza', CV: 'Cove',
  N: 'North', S: 'South', E: 'East', W: 'West', NE: 'Northeast', NW: 'Northwest', SE: 'Southeast', SW: 'Southwest', MT: 'Mount', FT: 'Fort', JR: 'Jr',
}

/** "BLK W SAM HOUSTON PKWY S" -> "West Sam Houston Parkway South"; null for things that are not a street. */
export function streetName(raw: string): string | null {
  let t = String(raw ?? '').toUpperCase().replace(/&NBSP;| /g, ' ')
  t = t.replace(/^\s*(BLK|BLOCK)\s+/, '').replace(/\b(IB|OB|NB|SB|EB|WB|UTRN|DRWY|EXIT|ENT|RAMP)\b/g, ' ').replace(/[^A-Z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim()
  if (!t || /^(DEAD END|DEAD-END|UNKNOWN|NONE)$/.test(t) || t.length < 3) return null
  const words = t.split(' ')
  return words
    .map((w, i) => {
      // A leading or trailing single letter is a direction; in the middle (like "H MARK") it is a name.
      if (ABBR[w] && (w.length > 2 || i === 0 || i === words.length - 1 || !['N', 'S', 'E', 'W'].includes(w))) return ABBR[w]
      return /^\d/.test(w) ? w.toLowerCase() : w.charAt(0) + w.slice(1).toLowerCase()
    })
    .join(' ')
}

/** "5200 BLOCK INTERNATIONAL DR" -> "5200 International Drive" (a number we can send to the Census geocoder). */
export function blockAddress(raw: string): string | null {
  const m = /^\s*(\d{1,6})\s+(?:BLOCK|BLK)?\s*(?:OF\s+)?(.+)$/i.exec(String(raw ?? ''))
  if (!m) return null
  const street = streetName(m[2]!)
  return street ? `${m[1]} ${street}` : null
}

/** Closest approach of two polylines, if they come within `maxM` metres of each other. */
export function meet(a: Line[], b: Line[], maxM = 40): Point | null {
  let best: { d: number; p: Point } | null = null
  const toXY = (lat0: number) => (p: [number, number]) => [p[1] * 111_320 * Math.cos((lat0 * Math.PI) / 180), p[0] * 110_540] as [number, number]
  const lat0 = a[0]?.[0]?.[0] ?? 0
  const xy = toXY(lat0)
  const segs = (lines: Line[]) => lines.flatMap((l) => l.slice(1).map((p, i) => [xy(l[i]!), xy(p)] as const))
  const A = segs(a)
  const B = segs(b)
  for (const [p1, p2] of A) {
    for (const [q1, q2] of B) {
      const hit = segmentClosest(p1, p2, q1, q2)
      if (hit.d <= maxM && (!best || hit.d < best.d)) best = { d: hit.d, p: { lat: hit.y / 110_540, lon: hit.x / (111_320 * Math.cos((lat0 * Math.PI) / 180)) } }
    }
  }
  return best ? { lat: Math.round(best.p.lat * 1e6) / 1e6, lon: Math.round(best.p.lon * 1e6) / 1e6 } : null
}

function segmentClosest(p1: [number, number], p2: [number, number], q1: [number, number], q2: [number, number]): { d: number; x: number; y: number } {
  const cands = [
    closestOn(q1, q2, p1),
    closestOn(q1, q2, p2),
    closestOn(p1, p2, q1),
    closestOn(p1, p2, q2),
  ]
  // A true crossing has distance 0 at the crossing point.
  const den = (p2[0] - p1[0]) * (q2[1] - q1[1]) - (p2[1] - p1[1]) * (q2[0] - q1[0])
  if (den !== 0) {
    const t = ((q1[0] - p1[0]) * (q2[1] - q1[1]) - (q1[1] - p1[1]) * (q2[0] - q1[0])) / den
    const u = ((q1[0] - p1[0]) * (p2[1] - p1[1]) - (q1[1] - p1[1]) * (p2[0] - p1[0])) / den
    if (t >= 0 && t <= 1 && u >= 0 && u <= 1) return { d: 0, x: p1[0] + t * (p2[0] - p1[0]), y: p1[1] + t * (p2[1] - p1[1]) }
  }
  return cands.reduce((m, c) => (c.d < m.d ? c : m))
}

function closestOn(a: [number, number], b: [number, number], p: [number, number]): { d: number; x: number; y: number } {
  const dx = b[0] - a[0]
  const dy = b[1] - a[1]
  const len = dx * dx + dy * dy
  const t = len ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len)) : 0
  const x = a[0] + t * dx
  const y = a[1] + t * dy
  // Report the midpoint between the two closest points, which sits on the corner.
  return { d: Math.hypot(p[0] - x, p[1] - y), x: (p[0] + x) / 2, y: (p[1] + y) / 2 }
}

export type Place = { city: string; state: string; bbox: [number, number, number, number] } // bbox: south, west, north, east

export class Geocoder {
  private queue: Promise<unknown> = Promise.resolve()
  private lastAt = 0
  /** Lookups allowed in the current minute (resets every minute). */
  private budget = { minute: 0, used: 0 }
  constructor(private readonly db: Database, private readonly f: typeof fetch = fetch, private readonly gapMs = 1100, private readonly perMinute = 40) {
    db.exec('CREATE TABLE IF NOT EXISTS geocache (key TEXT PRIMARY KEY, lat REAL, lon REAL, data TEXT, at INTEGER NOT NULL)')
  }

  private cached(key: string): { lat: number | null; lon: number | null; data: string | null } | undefined {
    return (this.db.query('SELECT lat, lon, data FROM geocache WHERE key = ?').get(key) as any) ?? undefined
  }
  private remember(key: string, p: Point | null, data: string | null = null) {
    this.db.query('INSERT OR REPLACE INTO geocache (key, lat, lon, data, at) VALUES (?, ?, ?, ?, ?)').run(key, p?.lat ?? null, p?.lon ?? null, data, Date.now())
  }

  /** One outbound lookup, spaced out, within the per-minute budget; OVER if the budget is spent. */
  private async polite<T>(fn: () => Promise<T>): Promise<T | typeof OVER> {
    const minute = Math.floor(Date.now() / 60_000)
    if (this.budget.minute !== minute) this.budget = { minute, used: 0 }
    if (this.budget.used >= this.perMinute) return OVER
    this.budget.used += 1
    const run = this.queue.then(async () => {
      const wait = this.lastAt + this.gapMs - Date.now()
      if (wait > 0) await Bun.sleep(wait)
      this.lastAt = Date.now()
      return fn()
    })
    this.queue = run.catch(() => {})
    return run
  }

  /** "5200 International Drive" in Orlando, FL. */
  async address(street: string, place: Place): Promise<Point | null> {
    const key = `addr:${place.city}|${place.state}|${street}`.toLowerCase()
    const hit = this.cached(key)
    if (hit) return hit.lat === null ? null : { lat: hit.lat, lon: hit.lon! }
    const r = await this.polite(async () => {
      const url = `https://geocoding.geo.census.gov/geocoder/locations/onelineaddress?benchmark=Public_AR_Current&format=json&address=${encodeURIComponent(`${street}, ${place.city}, ${place.state}`)}`
      const res = await this.f(url, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(15_000) })
      if (!res.ok) throw new Error(`census ${res.status}`)
      const m = (await res.json())?.result?.addressMatches?.[0]?.coordinates
      return m && inBox(m.y, m.x, place.bbox) ? { lat: Math.round(m.y * 1e6) / 1e6, lon: Math.round(m.x * 1e6) / 1e6 } : null
    }).catch(() => undefined)
    // A failed or skipped lookup is not a miss: it is tried again on the next read.
    if (r === undefined || r === OVER) return null
    this.remember(key, r)
    return r
  }

  /** Every OSM line named `street` inside the city's box. */
  private async lines(street: string, place: Place): Promise<Line[] | null> {
    const key = `street:${place.city}|${place.state}|${street}`.toLowerCase()
    const hit = this.cached(key)
    if (hit) return hit.data ? JSON.parse(hit.data) : []
    const [s, w, n, e] = place.bbox
    const r = await this.polite(async () => {
      const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&polygon_geojson=1&dedupe=0&limit=40&bounded=1&viewbox=${w},${n},${e},${s}&street=${encodeURIComponent(street)}&city=${encodeURIComponent(place.city)}&state=${encodeURIComponent(place.state)}&country=US`
      const res = await this.f(url, { headers: { 'user-agent': UA, 'accept-language': 'en' }, signal: AbortSignal.timeout(15_000) })
      if (!res.ok) throw new Error(`nominatim ${res.status}`)
      const list = (await res.json()) as any[]
      const out: Line[] = []
      for (const x of list) {
        const g = x?.geojson
        if (g?.type === 'LineString') out.push(g.coordinates.map(([lo, la]: number[]) => [la, lo]))
        else if (g?.type === 'MultiLineString') for (const l of g.coordinates) out.push(l.map(([lo, la]: number[]) => [la, lo]))
      }
      return out
    }).catch(() => undefined)
    if (r === undefined || r === OVER) return null
    this.remember(key, null, JSON.stringify(r))
    return r
  }

  /** Where two named streets meet inside the city. */
  async corner(a: string, b: string, place: Place): Promise<Point | null> {
    const [x, y] = [a, b].sort()
    const key = `corner:${place.city}|${place.state}|${x}|${y}`.toLowerCase()
    const hit = this.cached(key)
    if (hit) return hit.lat === null ? null : { lat: hit.lat, lon: hit.lon! }
    const la = await this.lines(a, place)
    const lb = la?.length ? await this.lines(b, place) : la
    if (!la || !lb) return null // not looked up yet (budget); try again next read
    const p = la.length && lb.length ? meet(la, lb) : null
    this.remember(key, p)
    return p
  }
}

export const inBox = (lat: number, lon: number, [s, w, n, e]: [number, number, number, number]) => lat >= s && lat <= n && lon >= w && lon <= e
