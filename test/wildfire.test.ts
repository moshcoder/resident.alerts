import { describe, expect, test } from 'bun:test'
import { SOURCES } from '../src/cities.js'
import { Store } from '../src/db.js'
import type { Pusher } from '../src/push.js'
import { RadioFinder } from '../src/radio.js'
import { createApp, thin } from '../src/server.js'
import type { Source } from '../src/sources.js'
import { aqiLabel, compass, ConditionsFinder, evacIncident, evacLevel, fireWeather, Hotspots, mergeFires, parseAirNow, rings, type CalFire } from '../src/wildfire.js'
import { matchPlace, message, notifyFollowers, readSource } from '../src/worker.js'
import { inc } from './store.test.js'

const square = (lat: number, lon: number, d = 0.05) => ({ type: 'Polygon', coordinates: [[[lon - d, lat - d], [lon + d, lat - d], [lon + d, lat + d], [lon - d, lat + d], [lon - d, lat - d]]] })
const point = (id: string, name: string, lat: number, lon: number, over: Record<string, unknown> = {}) => ({
  geometry: { type: 'Point', coordinates: [lon, lat] },
  properties: { UniqueFireIdentifier: id, IncidentName: name, IncidentSize: 120, PercentContained: 10, POOCounty: 'Santa Clara', POOState: 'US-CA', FireDiscoveryDateTime: Date.now() - 3 * 86_400_000, IncidentTypeCategory: 'WF', ...over },
})
const cal = (over: Partial<CalFire> = {}): CalFire => ({ Name: 'Summit Fire', Updated: '', Started: '2026-10-20T10:00:00Z', County: 'Santa Clara', Location: 'Summit Rd at Hwy 17', AcresBurned: 450, PercentContained: 35, Latitude: 37.15, Longitude: -121.98, Type: 'Wildfire', UniqueId: 'u1', Url: 'https://www.fire.ca.gov/incidents/2026/10/20/summit-fire/', IsActive: true, ...over })

describe('fires', () => {
  test('perimeters attach to their fire; prescribed burns are left out', () => {
    const list = mergeFires(
      [point('2026-CASCU-1', 'Summit', 37.15, -121.98), point('2026-GA-RX', 'RX Bird Dog', 34.9, -84.1, { IncidentTypeCategory: 'RX' })],
      [{ geometry: square(37.15, -121.98), properties: { attr_UniqueFireIdentifier: '2026-CASCU-1' } }],
      [],
    )
    expect(list).toHaveLength(1)
    expect(list[0]!.title).toBe('Summit Fire')
    expect(list[0]!.shape![0]![0]).toEqual([37.1, -122.03])
    expect(list[0]!.severity).toBe(2)
  })
  test('CAL FIRE joins the same fire by name and distance, and adds the ones WFIGS lacks', () => {
    const list = mergeFires([point('2026-CASCU-1', 'SUMMIT', 37.16, -121.99)], [], [cal(), cal({ Name: 'Oak Fire', UniqueId: 'u2', Latitude: 38.5, Longitude: -122.5, AcresBurned: 2000, PercentContained: null }), cal({ Name: 'Old Fire', UniqueId: 'u3', IsActive: false })])
    expect(list).toHaveLength(2)
    const summit = list.find((i) => i.id === 'wildfires:2026-CASCU-1')!
    expect(summit.detail).toBe('450 acres · 35% contained · Summit Rd at Hwy 17')
    expect(summit.url).toContain('fire.ca.gov')
    const oak = list.find((i) => i.id === 'wildfires:calfire-u2')!
    expect(oak.severity).toBe(3)
    expect(oak.detail).toBe('2,000 acres · Summit Rd at Hwy 17')
  })
  test('rings keep the biggest parts under a point budget', () => {
    const big = { type: 'MultiPolygon', coordinates: [square(1, 1).coordinates, [[[0, 0], [0, 1], [1, 0]]], square(2, 2).coordinates] }
    expect(rings(big)).toHaveLength(2)
    expect(rings(big, 6)).toHaveLength(1)
    expect(rings({ type: 'Point', coordinates: [0, 0] })).toEqual([])
  })
})

describe('evacuations', () => {
  test('zone statuses map to levels; lifted, normal and drills are nothing', () => {
    expect(evacLevel('Evacuation Order')).toBe(3)
    expect(evacLevel('Shelter in Place')).toBe(3)
    expect(evacLevel('Evacuation Warning')).toBe(2)
    expect(evacLevel('Evacuation Level 1: Be Ready')).toBe(1)
    expect(evacLevel('Advisory')).toBe(1)
    expect(evacLevel('Evacuation Order Lifted')).toBeNull()
    expect(evacLevel('Training')).toBeNull()
    expect(evacLevel('AutoStatus - Assigned')).toBeNull()
  })
  test('a zone becomes an area incident whose id changes with its status', () => {
    const feat = (status: string, layerName = 'Genasys', lat = '36.05', lon = '-119.01') => ({ geometry: { type: 'MultiPolygon', coordinates: [square(36.05, -119.01).coordinates] }, properties: { identifer: 'US-CA-XTU-PVL-E039', commonly_known_as: 'Porterville East', status, latitude: lat, longitude: lon, layerName } })
    const order = evacIncident(feat('Evacuation Order'))!
    expect(order.id).toBe('evac:US-CA-XTU-PVL-E039:evacuation-order')
    expect(order.title).toBe('Evacuation Order: Porterville East')
    expect(order.severity).toBe(3)
    expect(order.shape).toHaveLength(1)
    expect(evacIncident(feat('Evacuation Warning'))!.id).not.toBe(order.id)
    expect(evacIncident(feat('Lifted'))).toBeNull()
    expect(evacIncident(feat('Evacuation Order', 'Custom'))).toBeNull()
    expect(evacIncident(feat('Evacuation Order', 'Genasys', '38.99', '-1.86'))).toBeNull()
  })
})

describe('conditions', () => {
  test('compass, AQI words and fire weather', () => {
    expect(compass(0)).toBe('N')
    expect(compass(225)).toBe('SW')
    expect(compass(359)).toBe('N')
    expect(aqiLabel(42)).toBe('Good')
    expect(aqiLabel(160)).toBe('Unhealthy')
    expect(fireWeather({ humidity: 12, wind_mph: 20, gust_mph: 30 })).toBe(true)
    expect(fireWeather({ humidity: 40, wind_mph: 10, gust_mph: 45 })).toBe(true)
    expect(fireWeather({ humidity: 40, wind_mph: 10, gust_mph: 20 })).toBe(false)
  })
  const AIRNOW = `"AQSID","SiteName","Status","EPARegion","Latitude","Longitude","Elevation","GMTOffset","CountryCode","StateName","ValidDate","ValidTime","DataSource","ReportingArea_PipeDelimited","OZONE_AQI","PM10_AQI","PM25_AQI","NO2_AQI"
"060850005","San Jose - Jackson","Active","R9","37.3485","-121.8949","","-8","US","CA","10/26/2026","05:00","x","","30","","61",""
"060870007","Santa Cruz","Inactive","R9","36.98","-122.02","","-8","US","CA","10/26/2026","05:00","x","","","","150",""
"000000001","Nowhere","Active","R9","","","","-8","US","CA","10/26/2026","05:00","x","","","","20",""`
  test('AirNow sites take the worst pollutant; inactive and unplaced ones are skipped', () => {
    expect(parseAirNow(AIRNOW)).toEqual([{ name: 'San Jose - Jackson', lat: 37.3485, lon: -121.8949, aqi: 61 }])
  })
  test('wind from the nearest NWS station and AQI from the nearest monitor', async () => {
    const calls: string[] = []
    const f = (async (url: string | URL) => {
      const u = String(url)
      calls.push(u)
      if (u.includes('/points/')) return Response.json({ properties: { observationStations: 'https://api.weather.gov/gridpoints/MTR/95,78/stations' } })
      if (u.includes('/gridpoints/')) return Response.json({ features: [{ properties: { stationIdentifier: 'KSJC', name: 'San Jose International' } }] })
      if (u.includes('/observations/latest')) return Response.json({ properties: { timestamp: new Date(Date.now() - 20 * 60_000).toISOString(), temperature: { value: 30 }, relativeHumidity: { value: 11.6 }, windSpeed: { value: 40 }, windGust: { value: 64 }, windDirection: { value: 45 } } })
      if (u.includes('airnowtech')) return new Response(AIRNOW)
      return new Response('no', { status: 404 })
    }) as unknown as typeof fetch
    const finder = new ConditionsFinder(f)
    const c = await finder.near(37.3, -121.9)
    expect(c).toMatchObject({ station: 'San Jose International', temp_f: 86, humidity: 12, wind_mph: 25, gust_mph: 40, wind_from: 'NE', aqi: 61, aqi_label: 'Moderate', aqi_site: 'San Jose - Jackson', fire_weather: true })
    const n = calls.length
    await finder.near(37.3, -121.9)
    expect(calls.length).toBe(n)
  })
  test('hotspots are read for a snapped box, and a continent-sized box is refused', async () => {
    let asked = ''
    const f = (async (url: string | URL) => {
      asked = String(url)
      return Response.json({ features: [{ attributes: { latitude: 37.151234, longitude: -121.981234, hours_old: 3, frp: 12.34 } }] })
    }) as unknown as typeof fetch
    const h = new Hotspots(f)
    expect(await h.inBox([37.1, -122.2, 37.3, -121.8])).toEqual([{ lat: 37.1512, lon: -121.9812, hours: 3, frp: 12.3 }])
    expect(decodeURIComponent(asked)).toContain('geometry=-122.5,37,-121.5,37.5')
    await expect(h.inBox([20, -130, 50, -60])).rejects.toThrow('zoom in')
  })
})

const sub = (n = 1) => ({ endpoint: `https://push.example/${n}`, p256dh: 'p', auth: `a${n}` })
const fakePusher = () => {
  const sent: { id: string; title: string; body: string }[] = []
  const p: Pusher = { enabled: true, publicKey: 'k', send: async (d, m) => (sent.push({ id: d.id, title: m.title, body: m.body }), true) }
  return { p, sent }
}
const fire = (over: Record<string, unknown> = {}) => inc({ id: 'wildfires:F1', source: 'wildfires', kind: 'fire', severity: 2, title: 'Summit Fire', detail: '120 acres · 10% contained', at: Date.now() - 5 * 86_400_000, lat: 37.15, lon: -121.98, ...over })

describe('live sources', () => {
  test('ongoing incidents show however old; ended ones leave; changes are reported', () => {
    const s = new Store()
    const r1 = s.sync([fire(), fire({ id: 'wildfires:F2', title: 'Oak Fire', lat: 40, lon: -100 })], { live: 'wildfires' })
    expect(r1.fresh).toHaveLength(2)
    expect(s.near({ lat: 37.15, lon: -121.98, km: 5, sinceMs: Date.now() - 3600_000 }).map((i) => i.id)).toEqual(['wildfires:F1'])
    const r2 = s.sync([fire({ detail: '300 acres · 25% contained' })], { live: 'wildfires' })
    expect(r2.changed.map((i) => i.id)).toEqual(['wildfires:F1'])
    expect(r2.ended.map((i) => i.id)).toEqual(['wildfires:F2'])
    expect(s.incident('wildfires:F2')!.ended_at).toBeGreaterThan(0)
    expect(s.near({ sinceMs: 0 }).map((i) => i.id)).toEqual(['wildfires:F1'])
    // An old ongoing fire survives the 30-day prune.
    expect(s.prune(1)).toBe(1)
    expect(s.incident('wildfires:F1')).not.toBeNull()
  })
  test('an empty answer from a big live feed is an outage, not every fire going out', () => {
    const s = new Store()
    s.sync(Array.from({ length: 25 }, (_, n) => fire({ id: `wildfires:F${n}` })), { live: 'wildfires' })
    expect(s.sync([], { live: 'wildfires' }).ended).toHaveLength(0)
  })
  test('a perimeter counts from its nearest edge, and covers a place inside it', () => {
    const shape: [number, number][][] = [[[37.1, -122.0], [37.1, -121.9], [37.2, -121.9], [37.2, -122.0], [37.1, -122.0]]]
    const d = { places: [{ name: 'Home', lat: 37.23, lon: -121.95, km: 5 }], kinds: ['fire'] as any, min_severity: 1 as const }
    const m = matchPlace(d, fire({ shape, lat: 37.1, lon: -122.0 }))!
    expect(m.km).toBeCloseTo(3.3, 0)
    expect(matchPlace({ ...d, places: [{ name: 'Cabin', lat: 37.15, lon: -121.95, km: 1 }] }, fire({ shape }))).toEqual({ name: 'Cabin', km: 0 })
    expect(message(fire({ shape }), { name: 'Cabin', km: 0 }).body).toContain('covers Cabin')
  })
  test('followers hear each change once, and when it is over', async () => {
    const s = new Store()
    const d = s.saveDevice(sub(), { places: [{ name: 'Far', lat: 40, lon: -100, km: 1 }], kinds: ['fire'], min_severity: 1 })
    s.sync([fire()], { live: 'wildfires' })
    expect(s.follow(d.id, 'wildfires:F1', true)).toEqual(['wildfires:F1'])
    const { p, sent } = fakePusher()
    const grown = fire({ detail: '300 acres · 25% contained' })
    expect(await notifyFollowers({ store: s, pusher: p }, [grown], [])).toBe(1)
    expect(await notifyFollowers({ store: s, pusher: p }, [grown], [])).toBe(0)
    expect(await notifyFollowers({ store: s, pusher: p }, [], [grown])).toBe(1)
    expect(sent.map((x) => x.title)).toEqual(['🔥 Update: Summit Fire', '✅ Summit Fire: no longer listed as active'])
    expect(sent[0]!.body).toContain('300 acres')
  })
  test('a fire that grows to reach a place alerts it once, through the worker', async () => {
    const s = new Store()
    s.saveDevice(sub(), { places: [{ name: 'Home', lat: 37.23, lon: -121.95, km: 2 }], kinds: ['fire'], min_severity: 1 })
    const { p, sent } = fakePusher()
    const small: [number, number][][] = [[[37.1, -122.0], [37.1, -121.99], [37.11, -121.99], [37.1, -122.0]]]
    const big: [number, number][][] = [[[37.1, -122.0], [37.1, -121.9], [37.22, -121.9], [37.22, -122.0], [37.1, -122.0]]]
    let batch = [fire({ shape: small })]
    const src: Source = { id: 'wildfires', name: 'W', area: 'US', center: [0, 0], km: 2500, kinds: ['fire'], everyMs: 60_000, homepage: '', live: true, read: async () => batch }
    const deps = { store: s, sources: [src], pusher: p }
    await readSource(deps, src, { first: true })
    batch = [fire({ shape: big, detail: '4,000 acres · 5% contained', severity: 3 })]
    expect((await readSource(deps, src, { first: false })).pushed).toBe(1)
    batch = [fire({ shape: big, detail: '5,000 acres · 5% contained', severity: 3 })]
    expect((await readSource(deps, src, { first: false })).pushed).toBe(0)
    expect(sent[0]!.body).toContain('from Home')
  })
})

test('thinning keeps a ring closed and under its budget', () => {
  const ring = Array.from({ length: 1000 }, (_, n) => [Math.sin(n / 159), Math.cos(n / 159)] as [number, number])
  ring.push(ring[0]!)
  const [t] = thin([ring], 60)
  expect(t!.length).toBe(60)
  expect(t![59]).toEqual(t![0]!)
  expect(thin([[[0, 0], [1, 1], [0, 0]]], 60)[0]).toHaveLength(3)
})

describe('api', () => {
  const store = new Store()
  const pusher: Pusher = { enabled: true, publicKey: 'BPUB', send: async () => true }
  const premium = { coinpay: null, chains: [], cents: 499, comp: new Set<string>() } as any
  const hot = new Hotspots((async () => Response.json({ features: [{ attributes: { latitude: 37.15, longitude: -121.98, hours_old: 1, frp: 5 } }] })) as unknown as typeof fetch)
  const app = createApp({ store, sources: SOURCES, pusher, radio: new RadioFinder((async () => new Response('', { status: 404 })) as unknown as typeof fetch), premium, hotspots: hot })
  store.sync([fire(), inc({ id: 'evac:Z1:evacuation-order', source: 'evac', kind: 'hazard', severity: 3, title: 'Evacuation Order: Summit', lat: 37.16, lon: -121.97, shape: [[[37.15, -121.98], [37.15, -121.96], [37.17, -121.96], [37.15, -121.98]]] })], { live: 'x' })
  const post = (body: unknown) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

  test('/fires lists active fires and evacuation zones near a point', async () => {
    const r = await (await app.request('/api/v1/fires?lat=37.2&lon=-122')).json()
    expect(r.fires.map((i: any) => i.id)).toEqual(['wildfires:F1'])
    expect(r.evacuations.map((i: any) => i.id)).toEqual(['evac:Z1:evacuation-order'])
  })
  test('/hotspots needs a box', async () => {
    expect((await app.request('/api/v1/hotspots?s=37&w=-122')).status).toBe(400)
    const r = await (await app.request('/api/v1/hotspots?s=37&w=-122.2&n=37.3&e=-121.8')).json()
    expect(r.count).toBe(1)
  })
  test('following needs the device secret and a real incident', async () => {
    const subscription = { endpoint: 'https://push.example/follow', keys: { p256dh: 'p', auth: 'secret' } }
    expect((await app.request('/api/v1/devices/follow', post({ endpoint: subscription.endpoint, auth: 'secret', id: 'wildfires:F1' }))).status).toBe(404)
    await app.request('/api/v1/devices', post({ subscription, places: [{ name: 'Home', lat: 37.2, lon: -122, km: 2 }] }))
    expect((await app.request('/api/v1/devices/follow', post({ endpoint: subscription.endpoint, auth: 'wrong', id: 'wildfires:F1' }))).status).toBe(404)
    expect((await app.request('/api/v1/devices/follow', post({ endpoint: subscription.endpoint, auth: 'secret', id: 'nope' }))).status).toBe(404)
    const r = await (await app.request('/api/v1/devices/follow', post({ endpoint: subscription.endpoint, auth: 'secret', id: 'wildfires:F1' }))).json()
    expect(r.follows).toEqual(['wildfires:F1'])
    const off = await (await app.request('/api/v1/devices/follow', post({ endpoint: subscription.endpoint, auth: 'secret', id: 'wildfires:F1', follow: false }))).json()
    expect(off.follows).toEqual([])
  })
  test('a fire page has the conditions line and a follow button', async () => {
    const html = await (await app.request('/i/wildfires%3AF1')).text()
    expect(html).toContain('data-conditions')
    expect(html).toContain('data-follow="wildfires:F1"')
    expect(html).toContain('data-source="wildfires"')
  })
})
