/**
 * Wildfire, the way Watch Duty shows it: every active fire with its mapped
 * perimeter, CAL FIRE's own incident list for California, evacuation zones,
 * satellite heat detections, and the wind, humidity and air quality at a fire.
 *
 * All of it is public and keyless: NIFC's WFIGS layers, CAL FIRE's incident
 * API, Genasys Protect's zone map (the evacuation orders counties issue),
 * the VIIRS hotspot layer NASA FIRMS feeds to Esri's Living Atlas, NWS station
 * observations and EPA AirNow's hourly files.
 */
import { getJson, km, num, tidy, valid, type Incident, type Source } from './sources.js'

const UA = 'resident.alerts/0.1 (+https://resident.alerts.pit.world; alerts@pit.world)'
const HOUR = 3600_000

type Ring = [number, number][]

/** GeoJSON Polygon/MultiPolygon -> outer rings as [lat, lon], rounded, tiny slivers dropped, capped in size. */
export function rings(g: any, maxPoints = 4000): Ring[] {
  if (!g || (g.type !== 'Polygon' && g.type !== 'MultiPolygon')) return []
  const polys: number[][][][] = g.type === 'Polygon' ? [g.coordinates] : g.coordinates
  const out: Ring[] = []
  let points = 0
  // Biggest parts first, so a cap drops spot fires, not the main body.
  for (const poly of [...polys].sort((a, b) => (b[0]?.length ?? 0) - (a[0]?.length ?? 0))) {
    const outer = poly[0]
    if (!outer || outer.length < 4 || points + outer.length > maxPoints) continue
    out.push(outer.map(([lon, lat]) => [Math.round(lat! * 1e5) / 1e5, Math.round(lon! * 1e5) / 1e5] as [number, number]))
    points += outer.length
  }
  return out
}

const acresText = (a: number) => (a >= 10 ? Math.round(a).toLocaleString('en-US') : a.toFixed(1).replace(/\.0$/, '')) + ' acres'
const fireName = (s: string) => String(s ?? '').toLowerCase().replace(/\bfire\b/g, '').replace(/[^a-z0-9]/g, '')
const fireTitle = (s: string) => {
  // Agencies often shout ("COOLEY"); people say "Cooley Fire".
  const t = tidy(String(s ?? 'Wildfire').trim()).replace(/\b([a-z])/g, (c) => c.toUpperCase())
  return /\bfire$/i.test(t) ? t : `${t} Fire`
}
/** Size drives severity, the way a resident judges a fire: a spot fire, a real one, a big one. */
const fireSeverity = (acres: number): 1 | 2 | 3 => (acres >= 1000 ? 3 : acres >= 50 ? 2 : 1)

export type CalFire = { Name: string; Updated: string; Started: string; County: string; Location: string; AcresBurned: number | null; PercentContained: number | null; Latitude: number; Longitude: number; Type: string; UniqueId: string; Url: string; IsActive: boolean; AdminUnit?: string }

type Fire = { id: string; name: string; acres: number; contained: number | null; county: string; state: string; lat: number; lon: number; at: number; url: string; where: string; shape: Ring[] }

const toFire = (f: Fire): Incident => ({
  id: `wildfires:${f.id}`,
  source: 'wildfires',
  kind: 'fire',
  severity: fireSeverity(f.acres),
  title: fireTitle(f.name),
  detail: [f.acres ? acresText(f.acres) : '', f.contained === null ? '' : `${Math.round(f.contained)}% contained`, f.where].filter(Boolean).join(' · ').slice(0, 300),
  address: [f.county ? `${f.county.replace(/ County$/i, '')} County` : '', f.state].filter(Boolean).join(', '),
  area: 'Wildfire',
  lat: Math.round(f.lat * 1e6) / 1e6,
  lon: Math.round(f.lon * 1e6) / 1e6,
  at: f.at,
  url: f.url,
  ...(f.shape.length ? { shape: f.shape } : {}),
})

/**
 * One list of fires from three feeds. WFIGS has every agency's fires and the
 * perimeters; CAL FIRE is fresher on California fires and has the location in
 * words and an incident page. A CAL FIRE fire with the same name near a WFIGS
 * one is the same fire.
 */
export function mergeFires(points: any[], perimeters: any[], calfire: CalFire[]): Incident[] {
  const shapes = new Map<string, Ring[]>()
  for (const p of perimeters) {
    const id = p.properties?.attr_UniqueFireIdentifier
    const r = rings(p.geometry)
    if (id && r.length) shapes.set(id, r)
  }
  const fires: Fire[] = []
  for (const feat of points) {
    const p = feat.properties ?? {}
    const [lon, lat] = feat.geometry?.coordinates ?? []
    if (!valid(num(lat), num(lon)) || p.IncidentTypeCategory === 'RX' || /^RX\b/i.test(String(p.IncidentName ?? ''))) continue
    fires.push({
      id: String(p.UniqueFireIdentifier),
      name: String(p.IncidentName ?? 'Wildfire'),
      acres: Number(p.IncidentSize ?? 0) || 0,
      contained: p.PercentContained === null || p.PercentContained === undefined ? null : Number(p.PercentContained),
      county: String(p.POOCounty ?? ''),
      state: String(p.POOState ?? '').replace(/^US-/, ''),
      lat: num(lat),
      lon: num(lon),
      at: Number(p.FireDiscoveryDateTime) || Date.now(),
      url: 'https://www.nifc.gov/fire-information/nfn',
      where: '',
      shape: shapes.get(String(p.UniqueFireIdentifier)) ?? [],
    })
  }
  for (const c of calfire) {
    if (!c.IsActive || !/fire/i.test(c.Type || 'Wildfire') || !valid(num(c.Latitude), num(c.Longitude))) continue
    const name = fireName(c.Name)
    const same = fires.find((f) => f.state === 'CA' && km(f.lat, f.lon, c.Latitude, c.Longitude) < (fireName(f.name) === name ? 25 : 2))
    const acres = Number(c.AcresBurned ?? 0) || 0
    const contained = c.PercentContained === null || c.PercentContained === undefined ? null : Number(c.PercentContained)
    if (same) {
      // CAL FIRE updates California fires first; take its numbers when it has them.
      if (acres) same.acres = acres
      if (contained !== null) same.contained = contained
      same.url = c.Url || same.url
      same.where = String(c.Location ?? '').trim()
      continue
    }
    fires.push({
      id: `calfire-${c.UniqueId}`,
      name: c.Name,
      acres,
      contained,
      county: String(c.County ?? '').split(',')[0]!.trim(),
      state: 'CA',
      lat: c.Latitude,
      lon: c.Longitude,
      at: Date.parse(c.Started) || Date.now(),
      url: c.Url || 'https://www.fire.ca.gov/incidents',
      where: String(c.Location ?? '').trim(),
      shape: [],
    })
  }
  return fires.map(toFire)
}

const WFIGS = 'https://services3.arcgis.com/T4QMspbfLg3qTGWY/arcgis/rest/services'

/** Active wildfires (NIFC WFIGS + CAL FIRE) with their perimeters. */
export const WILDFIRES: Source = {
  id: 'wildfires',
  name: 'Wildfires: NIFC, CAL FIRE and fire perimeters',
  area: 'United States',
  center: [39.5, -98.35],
  km: 2500,
  kinds: ['fire'],
  everyMs: 5 * 60_000,
  live: true,
  homepage: 'https://data-nifc.opendata.arcgis.com/',
  async read(f) {
    // New in the last two weeks, or big and still burning: a month-old fire that is still growing stays on the map.
    const since = new Date(Date.now() - 14 * 24 * HOUR).toISOString().slice(0, 19).replace('T', ' ')
    const where = encodeURIComponent(`FireDiscoveryDateTime >= TIMESTAMP '${since}' OR (IncidentSize >= 100 AND (PercentContained IS NULL OR PercentContained < 100))`)
    const fields = 'UniqueFireIdentifier,IncidentName,FireDiscoveryDateTime,IncidentSize,PercentContained,POOCounty,POOState,IncidentTypeCategory'
    const [points, perimeters, calfire] = await Promise.all([
      getJson(f, `${WFIGS}/WFIGS_Incident_Locations_Current/FeatureServer/0/query?where=${where}&outFields=${fields}&outSR=4326&f=geojson&resultRecordCount=2000`),
      // Perimeters and CAL FIRE only add to the points; either one being down must not empty the map.
      getJson(f, `${WFIGS}/WFIGS_Interagency_Perimeters_Current/FeatureServer/0/query?where=1%3D1&outFields=attr_UniqueFireIdentifier&returnGeometry=true&geometryPrecision=5&maxAllowableOffset=0.0005&outSR=4326&f=geojson&resultRecordCount=2000`).catch(() => null),
      getJson(f, 'https://incidents.fire.ca.gov/umbraco/api/IncidentApi/List?inactive=false').catch(() => []),
    ])
    return mergeFires(points?.features ?? [], perimeters?.features ?? [], Array.isArray(calfire) ? calfire : [])
  },
}

/** A zone's status -> how serious it is, or null for "nothing to do" (normal, lifted, a drill). */
export function evacLevel(status: string): 1 | 2 | 3 | null {
  const s = String(status ?? '')
  if (!s || /lifted|normal|training|autostatus|clear|repopulat/i.test(s)) return null
  if (/order|level 3|go now|shelter/i.test(s)) return 3
  if (/warning|level 2|get set/i.test(s)) return 2
  if (/advisory|level 1|be ready|watch/i.test(s)) return 1
  return null
}

const EVAC_WFS = 'https://cdngeospatialcei.zonehaven.com/geoserver/zonehavenv2/wfs'

export function evacIncident(feat: any, now = Date.now()): Incident | null {
  const p = feat?.properties ?? {}
  const level = evacLevel(p.status)
  const lat = num(p.latitude)
  const lon = num(p.longitude)
  // US and territories only: other layers in the same map are drills and other countries' tests.
  if (!level || !valid(lat, lon) || lon > -64 || lat < 13 || p.layerName === 'Custom') return null
  const shape = rings(feat.geometry, 3000)
  const zone = String(p.identifer ?? feat.id ?? '').trim()
  const name = String(p.commonly_known_as ?? '').replace(/[,\s]+$/, '').trim()
  return {
    // The status is part of the id: a warning that becomes an order is a new alert.
    id: `evac:${zone}:${String(p.status).toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
    source: 'evac',
    kind: 'hazard',
    severity: level,
    title: `${/evacuation|shelter/i.test(p.status) ? '' : 'Evacuation '}${String(p.status).trim()}${name ? `: ${name}` : ''}`,
    detail: level === 3 ? 'Leave now if you are in this zone. Follow your county\'s instructions.' : level === 2 ? 'Be ready to leave: pack, plan your route, move pets and anyone who needs help.' : 'Stay alert: conditions may change.',
    address: `Evacuation zone ${zone}`,
    area: 'Evacuation zones',
    lat: Math.round(lat * 1e6) / 1e6,
    lon: Math.round(lon * 1e6) / 1e6,
    at: now,
    url: 'https://protect.genasys.com/',
    ...(shape.length ? { shape } : {}),
  }
}

/** Evacuation orders, warnings and advisories that counties publish through Genasys Protect. */
export const EVACUATIONS: Source = {
  id: 'evac',
  name: 'Evacuation zones (Genasys Protect)',
  area: 'United States',
  center: [39.5, -98.35],
  km: 2500,
  kinds: ['hazard'],
  everyMs: 3 * 60_000,
  live: true,
  homepage: 'https://protect.genasys.com/',
  async read(f) {
    const cql = encodeURIComponent("status <> 'Normal' AND status NOT LIKE '%Lifted%' AND status NOT LIKE 'AutoStatus%' AND status <> 'Training'")
    const doc = await getJson(f, `${EVAC_WFS}?service=WFS&version=2.0.0&request=GetFeature&typeNames=zonehavenv2:evacuation_zone&outputFormat=application/json&srsName=EPSG:4326&propertyName=geom,identifer,commonly_known_as,status,latitude,longitude,layerName&cql_filter=${cql}&count=3000`)
    const now = Date.now()
    return (doc?.features ?? []).flatMap((feat: any) => evacIncident(feat, now) ?? [])
  },
}

// ---- map layers and conditions, on demand -----------------------------------------

/** A small time-boxed cache, so a busy map is one upstream call per area per few minutes. */
class Cache<T> {
  private m = new Map<string, { at: number; v: Promise<T> }>()
  constructor(readonly ttl: number, readonly max = 500) {}
  get(key: string, make: () => Promise<T>): Promise<T> {
    const hit = this.m.get(key)
    if (hit && Date.now() - hit.at < this.ttl) return hit.v
    const v = make()
    // A failure is not cached: the next caller tries again.
    v.catch(() => this.m.delete(key))
    this.m.set(key, { at: Date.now(), v })
    if (this.m.size > this.max) this.m.delete(this.m.keys().next().value!)
    return v
  }
}

export type Hotspot = { lat: number; lon: number; hours: number; frp: number }
const VIIRS = 'https://services9.arcgis.com/RHVPKKiFTONKtxq3/arcgis/rest/services/Satellite_VIIRS_Thermal_Hotspots_and_Fire_Activity/FeatureServer/0/query'

/** Satellite heat detections (VIIRS, last 48 hours) inside a box, for the map's hotspot layer. */
export class Hotspots {
  private cache = new Cache<Hotspot[]>(10 * 60_000)
  constructor(readonly f: typeof fetch = fetch) {}
  /** box = [south, west, north, east]; snapped to half a degree so neighbors share a cache entry. */
  async inBox(box: [number, number, number, number]): Promise<Hotspot[]> {
    const snap = (v: number, up: boolean) => (up ? Math.ceil(v * 2) : Math.floor(v * 2)) / 2
    const [s, w, n, e] = [snap(box[0], false), snap(box[1], false), snap(box[2], true), snap(box[3], true)]
    if (n - s > 12 || e - w > 16) throw new Error('zoom in to see hotspots')
    return this.cache.get(`${s},${w},${n},${e}`, async () => {
      const q = new URLSearchParams({ where: 'hours_old <= 48', geometry: `${w},${s},${e},${n}`, geometryType: 'esriGeometryEnvelope', inSR: '4326', spatialRel: 'esriSpatialRelIntersects', outFields: 'latitude,longitude,hours_old,frp', returnGeometry: 'false', orderByFields: 'hours_old ASC', resultRecordCount: '4000', f: 'json' })
      const doc = await getJson(this.f, `${VIIRS}?${q}`)
      if (doc?.error) throw new Error(doc.error.message ?? 'hotspot layer error')
      return (doc?.features ?? []).flatMap((x: any): Hotspot[] => {
        const a = x.attributes ?? {}
        const lat = num(a.latitude)
        const lon = num(a.longitude)
        return valid(lat, lon) ? [{ lat: Math.round(lat * 1e4) / 1e4, lon: Math.round(lon * 1e4) / 1e4, hours: Number(a.hours_old) || 0, frp: Math.round(Number(a.frp) * 10) / 10 || 0 }] : []
      })
    })
  }
}

export type Conditions = {
  station: string | null
  observed_at: number | null
  temp_f: number | null
  humidity: number | null
  wind_mph: number | null
  gust_mph: number | null
  /** Where the wind comes FROM, degrees and as a compass point. */
  wind_from_deg: number | null
  wind_from: string | null
  aqi: number | null
  aqi_label: string | null
  aqi_site: string | null
  /** Hot, dry and windy: the conditions that let a fire run. */
  fire_weather: boolean
}

const COMPASS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW']
export const compass = (deg: number) => COMPASS[Math.round((((deg % 360) + 360) % 360) / 22.5) % 16]!
export const aqiLabel = (aqi: number) => (aqi <= 50 ? 'Good' : aqi <= 100 ? 'Moderate' : aqi <= 150 ? 'Unhealthy for sensitive groups' : aqi <= 200 ? 'Unhealthy' : aqi <= 300 ? 'Very unhealthy' : 'Hazardous')

/** Red-flag-like: humidity at or under 15% with wind or gusts of 25 mph, or anything gusting 40+. */
export const fireWeather = (c: Pick<Conditions, 'humidity' | 'wind_mph' | 'gust_mph'>) =>
  (c.humidity !== null && c.humidity <= 15 && Math.max(c.wind_mph ?? 0, c.gust_mph ?? 0) >= 25) || (c.gust_mph ?? 0) >= 40

type AqSite = { name: string; lat: number; lon: number; aqi: number }

/** One AirNow hourly file (CSV, every monitor in North America) -> sites with a current AQI. */
export function parseAirNow(text: string): AqSite[] {
  const lines = text.split(/\r?\n/)
  const head = (lines[0] ?? '').split(',').map((h) => h.replace(/"/g, ''))
  const col = (n: string) => head.indexOf(n)
  const [cName, cLat, cLon, cPm, cO3, cPm10, cStatus] = ['SiteName', 'Latitude', 'Longitude', 'PM25_AQI', 'OZONE_AQI', 'PM10_AQI', 'Status'].map(col)
  const out: AqSite[] = []
  for (const line of lines.slice(1)) {
    if (!line) continue
    const v = line.split('","').map((x) => x.replace(/^"|"$/g, ''))
    if (v[cStatus!] && v[cStatus!] !== 'Active') continue
    const aqi = Math.max(...[cPm, cO3, cPm10].map((c) => Number(v[c!] || NaN)).filter(Number.isFinite))
    const lat = num(v[cLat!])
    const lon = num(v[cLon!])
    if (Number.isFinite(aqi) && aqi >= 0 && valid(lat, lon)) out.push({ name: v[cName!] ?? '', lat, lon, aqi })
  }
  return out
}

/** Wind, humidity and temperature from the nearest NWS station, and AQI from the nearest AirNow monitor. */
export class ConditionsFinder {
  private cache = new Cache<Conditions>(15 * 60_000, 2000)
  private stations = new Cache<{ id: string; name: string }[]>(7 * 24 * HOUR, 5000)
  private aq: { at: number; sites: AqSite[] } = { at: 0, sites: [] }
  private aqLoading: Promise<void> | null = null
  constructor(readonly f: typeof fetch = fetch) {}

  private async airNow(): Promise<AqSite[]> {
    if (Date.now() - this.aq.at < HOUR) return this.aq.sites
    this.aqLoading ??= (async () => {
      // The newest file appears a little after the hour; try the last three.
      for (let back = 1; back <= 3; back++) {
        const t = new Date(Date.now() - back * HOUR).toISOString()
        const h = t.slice(0, 13).replace(/[-T]/g, '')
        const r = await this.f(`https://files.airnowtech.org/airnow/${h.slice(0, 4)}/${h.slice(0, 8)}/HourlyAQObs_${h}.dat`, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(30_000) }).catch(() => null)
        if (r?.ok) {
          this.aq = { at: Date.now(), sites: parseAirNow(await r.text()) }
          return
        }
      }
      // Keep the old list, but do not hammer the server: try again in ten minutes.
      this.aq.at = Date.now() - HOUR + 10 * 60_000
    })().finally(() => (this.aqLoading = null))
    await this.aqLoading
    return this.aq.sites
  }

  private station(lat: number, lon: number) {
    return this.stations.get(`${lat.toFixed(2)},${lon.toFixed(2)}`, async () => {
      const pt = await getJson(this.f, `https://api.weather.gov/points/${lat.toFixed(4)},${lon.toFixed(4)}`)
      const url = pt?.properties?.observationStations
      if (!url) return null
      const list = await getJson(this.f, `${url}?limit=4`)
      return (list?.features ?? []).map((x: any) => x.properties).filter(Boolean).map((s: any) => ({ id: String(s.stationIdentifier), name: String(s.name ?? s.stationIdentifier) }))
    })
  }

  /** The nearest station that has reported in the last three hours (small stations go quiet for days). */
  private async observation(lat: number, lon: number) {
    for (const st of (await this.station(lat, lon).catch(() => [])).slice(0, 3)) {
      const obs = (await getJson(this.f, `https://api.weather.gov/stations/${st.id}/observations/latest`).catch(() => null))?.properties
      if (obs && Date.now() - Date.parse(obs.timestamp) < 3 * HOUR) return { st, obs }
    }
    return null
  }

  near(lat: number, lon: number): Promise<Conditions> {
    return this.cache.get(`${lat.toFixed(2)},${lon.toFixed(2)}`, async () => {
      const [wx, sites] = await Promise.all([
        this.observation(lat, lon),
        this.airNow().catch(() => [] as AqSite[]),
      ])
      const o = wx?.obs ?? {}
      const v = (x: any) => (x && x.value !== null && x.value !== undefined && Number.isFinite(Number(x.value)) ? Number(x.value) : null)
      const kmh = (x: number | null) => (x === null ? null : Math.round(x * 0.621371))
      const c = v(o.temperature)
      let best: AqSite | null = null
      let bestKm = 50
      for (const s of sites) {
        if (Math.abs(s.lat - lat) > 0.6 || Math.abs(s.lon - lon) > 0.8) continue
        const d = km(lat, lon, s.lat, s.lon)
        if (d < bestKm) { best = s; bestKm = d }
      }
      const dir = v(o.windDirection)
      const out: Conditions = {
        station: wx ? wx.st.name : null,
        observed_at: o.timestamp ? Date.parse(o.timestamp) : null,
        temp_f: c === null ? null : Math.round(c * 1.8 + 32),
        humidity: v(o.relativeHumidity) === null ? null : Math.round(v(o.relativeHumidity)!),
        wind_mph: kmh(v(o.windSpeed)),
        gust_mph: kmh(v(o.windGust)),
        wind_from_deg: dir,
        wind_from: dir === null ? null : compass(dir),
        aqi: best ? Math.round(best.aqi) : null,
        aqi_label: best ? aqiLabel(best.aqi) : null,
        aqi_site: best ? best.name : null,
        fire_weather: false,
      }
      out.fire_weather = fireWeather(out)
      return out
    })
  }
}
