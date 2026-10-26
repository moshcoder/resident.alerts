import { describe, expect, test } from 'bun:test'
import { cleanKinds, cleanPlaces, Store } from '../src/db.js'
import type { Pusher } from '../src/push.js'
import type { Incident, Source } from '../src/sources.js'
import { fanOut, matchPlace, message, PER_DEVICE_HOURLY, readSource } from '../src/worker.js'

export const inc = (over: Partial<Incident> = {}): Incident => ({
  id: `t:${Math.random().toString(36).slice(2)}`, source: 't', kind: 'police', severity: 2, title: 'Suspicious person', detail: '', address: '1st & Main', area: 'Testville',
  lat: 47.61, lon: -122.33, at: Date.now() - 60_000, url: '', ...over,
})
const sub = (n = 1) => ({ endpoint: `https://push.example/${n}`, p256dh: 'p', auth: `a${n}` })
const fakePusher = () => {
  const sent: { id: string; title: string }[] = []
  const p: Pusher = { enabled: true, publicKey: 'k', send: async (d, m) => (sent.push({ id: d.id, title: m.title }), true) }
  return { p, sent }
}

describe('store', () => {
  test('upsert says which incidents are new', () => {
    const s = new Store()
    const a = inc()
    expect(s.upsertIncidents([a])).toHaveLength(1)
    expect(s.upsertIncidents([a, inc()])).toHaveLength(1)
    expect(s.incident(a.id)?.title).toBe('Suspicious person')
  })
  test('near() keeps the radius, the kinds and the window', () => {
    const s = new Store()
    s.upsertIncidents([inc({ id: 'near' }), inc({ id: 'far', lat: 47.9 }), inc({ id: 'old', at: Date.now() - 3 * 86_400_000 }), inc({ id: 'fire', kind: 'fire' })])
    const ids = s.near({ lat: 47.61, lon: -122.33, km: 5 }).map((i) => i.id).sort()
    expect(ids).toEqual(['fire', 'near'])
    expect(s.near({ lat: 47.61, lon: -122.33, km: 5, kinds: ['fire'] }).map((i) => i.id)).toEqual(['fire'])
    expect(s.near({ lat: 47.61, lon: -122.33, km: 5 })[0]!.distance_km).toBe(0)
  })
  test('a weather polygon counts for any point inside it', () => {
    const s = new Store()
    const shape: [number, number][][] = [[[47, -123], [47, -121], [48.5, -121], [48.5, -123], [47, -123]]]
    s.upsertIncidents([inc({ id: 'nws', kind: 'weather', lat: 47.75, lon: -122, shape })])
    expect(s.near({ lat: 48.4, lon: -122.9, km: 1 }).map((i) => i.id)).toEqual(['nws'])
    expect(s.near({ lat: 49.5, lon: -122.9, km: 1 })).toHaveLength(0)
  })
  test('devices: saved by endpoint, changed only with the auth secret', () => {
    const s = new Store()
    s.saveDevice(sub(), { places: [{ name: 'Home', lat: 47.6, lon: -122.3, km: 2 }], kinds: ['police'], min_severity: 2 })
    expect(s.countDevices()).toBe(1)
    expect(s.deviceFor(sub().endpoint, 'wrong')).toBeNull()
    expect(s.deviceFor(sub().endpoint, 'a1')?.places[0]!.name).toBe('Home')
    expect(s.deleteDevice(sub().endpoint)).toBe(true)
  })
  test('places and kinds are cleaned', () => {
    expect(cleanPlaces([{ name: '', lat: 1, lon: 2 }])).toEqual([{ name: 'Place', lat: 1, lon: 2, km: 2 }])
    expect(cleanPlaces([{ lat: 100, lon: 0 }])).toBeTypeOf('string')
    expect(cleanPlaces([{ lat: 1, lon: 1, km: 500 }])).toBeTypeOf('string')
    expect(cleanKinds(['fire', 'nope'])).toEqual(['fire'])
    expect(cleanKinds([])).toHaveLength(8)
  })
})

describe('alerts', () => {
  const device = { places: [{ name: 'Home', lat: 47.61, lon: -122.33, km: 1 }], kinds: ['police', 'fire'] as any, min_severity: 2 as const }
  test('a device matches inside its radius, for its kinds and severity', () => {
    expect(matchPlace(device, inc())?.name).toBe('Home')
    expect(matchPlace(device, inc({ lat: 47.7 }))).toBeNull()
    expect(matchPlace(device, inc({ kind: 'medical' }))).toBeNull()
    expect(matchPlace(device, inc({ severity: 1 }))).toBeNull()
  })
  test('the message says what, where and how far', () => {
    const m = message(inc({ title: 'Shots fired', severity: 3, lat: 47.615 }), { name: 'Home', km: 0.55 })
    expect(m.title).toBe('🚓 Shots fired')
    expect(m.body).toContain('0.3 mi from Home')
    expect(m.urgent).toBe(true)
  })
  test('fresh incidents go out once per device; old ones never', async () => {
    const s = new Store()
    s.saveDevice(sub(), { places: device.places, kinds: ['police'], min_severity: 1 })
    const { p, sent } = fakePusher()
    const a = inc()
    expect(await fanOut({ store: s, pusher: p }, [a, inc({ at: Date.now() - 2 * 3600_000 })])).toBe(1)
    expect(await fanOut({ store: s, pusher: p }, [a])).toBe(0)
    expect(sent).toHaveLength(1)
  })
  test('a busy hour is capped per device, most serious first', async () => {
    const s = new Store()
    s.saveDevice(sub(), { places: device.places, kinds: ['police'], min_severity: 1 })
    const { p, sent } = fakePusher()
    const list = Array.from({ length: PER_DEVICE_HOURLY + 5 }, (_, n) => inc({ title: `call ${n}`, severity: 1 }))
    list.push(inc({ title: 'Shots fired', severity: 3 }))
    await fanOut({ store: s, pusher: p }, list)
    expect(sent).toHaveLength(PER_DEVICE_HOURLY)
    expect(sent[0]!.title).toContain('Shots fired')
  })
  test("a source's first read fills the map without pushing", async () => {
    const s = new Store()
    s.saveDevice(sub(), { places: device.places, kinds: ['police'], min_severity: 1 })
    const { p, sent } = fakePusher()
    let batch = [inc({ id: 't:1' })]
    const src: Source = { id: 't', name: 'T', area: 'T', center: [0, 0], km: 1, kinds: ['police'], everyMs: 60_000, homepage: '', read: async () => batch }
    expect((await readSource({ store: s, sources: [src], pusher: p }, src, { first: true })).pushed).toBe(0)
    batch = [inc({ id: 't:1' }), inc({ id: 't:2' })]
    expect((await readSource({ store: s, sources: [src], pusher: p }, src, { first: false })).pushed).toBe(1)
    expect(sent).toHaveLength(1)
    expect(s.sourceState('t').last_count).toBe(2)
  })
  test('a failing source backs off and keeps its last good count', async () => {
    const s = new Store()
    const src: Source = { id: 'x', name: 'X', area: 'X', center: [0, 0], km: 1, kinds: ['police'], everyMs: 60_000, homepage: '', read: async () => { throw new Error('down') } }
    const r = await readSource({ store: s, sources: [src], pusher: fakePusher().p }, src, { first: false })
    expect(r.ok).toBe(false)
    expect(s.sourceState('x').last_error).toBe('down')
    expect(s.sourceState('x').next_at).toBeGreaterThan(Date.now() + 100_000)
  })
})
