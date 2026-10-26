import { describe, expect, test } from 'bun:test'
import { createHmac } from 'node:crypto'
import { SOURCES } from '../src/cities.js'
import { Store } from '../src/db.js'
import type { Pusher } from '../src/push.js'
import { normCounty, parseCountyPage, parseStatePage, RadioFinder } from '../src/radio.js'
import { createApp } from '../src/server.js'
import { hashKey, newKey } from '../src/premium.js'
import { parseArgs, queryFrom } from '../src/cli.js'
import { absorb, initialState, onKey } from '../src/tui.js'
import { inc } from './store.test.js'

const COUNTY = `<table class="table table-sm portal-table listen-feed-table listen-sortable"><thead><tr><th></th></tr></thead><tbody><tr><td><span class="portal-status portal-status-online" title="Online"></span></td><td><a href="/listen/feed/43916">Camano Island Fire and Rescue</a></td><td><span class="listen-genre-badge">Public Safety</span></td><td class="text-end" data-sort-value="0">0</td></tr><tr><td><span class="portal-status portal-status-online"></span></td><td><a href="/listen/feed/19037">Island County Public Safety</a></td><td><span class="listen-genre-badge">Public Safety</span></td><td class="text-end" data-sort-value="7">7</td></tr><tr><td><span class="portal-status portal-status-offline"></span></td><td><a href="/listen/feed/1">Dead feed</a></td><td><span class="listen-genre-badge">Public Safety</span></td><td data-sort-value="0">0</td></tr></tbody></table>`

const fakeFetch = (async (url: string | URL) => {
  const u = String(url)
  if (u.includes('geo.fcc.gov')) return Response.json({ results: [{ county_name: 'Island County', county_fips: '53029', state_name: 'Washington', state_code: 'WA', state_fips: '53' }] })
  if (u.endsWith('/listen/stid/53')) return new Response('<a href="/listen/ctid/2972">Island</a><a href="/listen/ctid/2965">Cowlitz</a>')
  if (u.endsWith('/listen/ctid/2972')) return new Response(COUNTY)
  return new Response('nope', { status: 404 })
}) as unknown as typeof fetch

const COMP = newKey()
function setup(push = true, fetcher?: typeof fetch) {
  const store = new Store()
  const sent: string[] = []
  const pusher: Pusher = push ? { enabled: true, publicKey: 'BPUB', send: async (d) => (sent.push(d.id), true) } : { enabled: false, publicKey: '', send: async () => false }
  const premium = { coinpay: { baseUrl: 'https://coinpay.test', apiKey: 'k', businessId: 'b', webhookSecret: 'whsec' }, chains: ['BTC'], cents: 499, comp: new Set([hashKey(COMP)]) }
  const app = createApp({ store, sources: SOURCES, pusher, radio: new RadioFinder(fakeFetch), premium, ...(fetcher ? { fetch: fetcher } : {}) })
  return { app, store, sent }
}
const json = (body: unknown, method = 'POST') => ({ method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
const subscription = { endpoint: 'https://push.example/abc', keys: { p256dh: 'p', auth: 'secret' } }

describe('pages', () => {
  test('home renders the app, the ring and both footers', async () => {
    const { app } = setup()
    const r = await app.request('/')
    const html = await r.text()
    expect(r.status).toBe(200)
    expect(html).toContain('id="map"')
    expect(html).toContain('ring-bar')
    expect(html).toContain('ring/profullstack')
    expect(r.headers.get('content-security-policy')).toContain('tile.openstreetmap.org')
  })
  test('an incident page and a missing one', async () => {
    const { app, store } = setup()
    const i = inc({ id: 'seattle-fire:F1', source: 'seattle-fire', title: 'Fire in Building', kind: 'fire', severity: 3 })
    store.upsertIncidents([i])
    const r = await app.request(`/i/${encodeURIComponent(i.id)}`)
    expect(r.status).toBe(200)
    expect(await r.text()).toContain('Fire in Building')
    expect((await app.request('/i/nope')).status).toBe(404)
  })
  test('coverage, about, api, radio, tip, health', async () => {
    const { app } = setup()
    for (const p of ['/coverage', '/about', '/api', '/radio', '/premium', '/health', '/sitemap.xml', '/robots.txt', '/llms.txt', '/manifest.webmanifest', '/sw.js', '/vendor/leaflet.js']) expect((await app.request(p)).status).toBe(200)
    const radio = await (await app.request('/radio?lat=48.2&lon=-122.5')).text()
    expect(radio).toContain('Island County Public Safety')
  })
})

describe('api', () => {
  test('incidents near a point, with CORS', async () => {
    const { app, store } = setup()
    store.upsertIncidents([inc({ id: 'a' }), inc({ id: 'b', lat: 40 })])
    const r = await app.request('/api/v1/incidents?lat=47.61&lon=-122.33&km=3')
    expect(r.headers.get('access-control-allow-origin')).toBe('*')
    const body = (await r.json()) as any
    expect(body.incidents.map((i: any) => i.id)).toEqual(['a'])
    expect((await app.request('/api/v1/incidents/a')).status).toBe(200)
    expect((await app.request('/api/v1/sources')).status).toBe(200)
  })
  test('radio for a point', async () => {
    const { app } = setup()
    const r = (await (await app.request('/api/v1/radio?lat=48.2&lon=-122.5')).json()) as any
    expect(r.county).toBe('Island County')
    expect(r.feeds[0].name).toBe('Island County Public Safety')
    expect((await app.request('/api/v1/radio')).status).toBe(400)
  })
  test('devices: on, look up, test, change, off', async () => {
    const { app, store, sent } = setup()
    const places = [{ name: 'Home', lat: 47.6, lon: -122.3, km: 2 }]
    expect((await app.request('/api/v1/devices', json({ subscription, places: [] }))).status).toBe(400)
    expect((await app.request('/api/v1/devices', json({ subscription, places, kinds: ['fire'], min_severity: 3 }))).status).toBe(200)
    const look = (await (await app.request('/api/v1/devices/lookup', json({ endpoint: subscription.endpoint, auth: 'secret' }))).json()) as any
    expect(look.device.kinds).toEqual(['fire'])
    expect((await app.request('/api/v1/devices/lookup', json({ endpoint: subscription.endpoint, auth: 'nope' }))).status).toBe(404)
    // Someone who knows only the endpoint cannot take the device over.
    expect((await app.request('/api/v1/devices', json({ subscription: { ...subscription, keys: { p256dh: 'x', auth: 'other' } }, places }))).status).toBe(403)
    expect((await app.request('/api/v1/devices/test', json({ endpoint: subscription.endpoint, auth: 'secret' }))).status).toBe(200)
    expect(sent).toHaveLength(1)
    await app.request('/api/v1/devices', json({ endpoint: subscription.endpoint, auth: 'secret' }, 'DELETE'))
    expect(store.countDevices()).toBe(0)
  })
  test('without VAPID keys, push says so', async () => {
    const { app } = setup(false)
    expect((await app.request('/api/v1/devices', json({ subscription, places: [{ lat: 1, lon: 1 }] }))).status).toBe(503)
  })
})

const sign = (body: string) => {
  const t = Math.floor(Date.now() / 1000)
  return `t=${t},v1=${createHmac('sha256', 'whsec').update(`${t}.${body}`).digest('hex')}`
}

describe('premium', () => {
  test('checkout, then the key works only once CoinPay settles it', async () => {
    let sentBody: any = null
    const coinpay = (async (_u: string, init: any) => ((sentBody = JSON.parse(init.body)), Response.json({ success: true, payment: { id: 'pay_9' } }))) as unknown as typeof fetch
    const { app, store } = setup(true, coinpay)
    const r = await app.request('/premium', { method: 'POST', body: new URLSearchParams({ chain: 'BTC' }) })
    expect(r.status).toBe(302)
    expect(r.headers.get('location')).toBe('https://coinpay.test/pay/pay_9')
    expect(sentBody.amount).toBe(4.99)
    const key = String(sentBody.success_url).split('/premium/k/')[1]!
    const check = async () => ((await (await app.request('/api/v1/premium/check', json({ key }))).json()) as any).premium
    expect(await check()).toBe(false)
    expect(await (await app.request(`/premium/k/${key}`)).text()).toContain('Waiting for the payment')
    const body = JSON.stringify({ data: { payment_id: 'pay_9', status: 'confirmed' } })
    expect((await app.request('/hooks/coinpay', { method: 'POST', body, headers: { 'x-coinpay-signature': sign(body) } })).status).toBe(200)
    expect(await check()).toBe(true)
    expect(await (await app.request(`/premium/k/${key}`)).text()).toContain('data-premium-key')
    // A later "failed" webhook never takes it back.
    const later = JSON.stringify({ data: { payment_id: 'pay_9', status: 'failed' } })
    await app.request('/hooks/coinpay', { method: 'POST', body: later, headers: { 'x-coinpay-signature': sign(later) } })
    expect(store.licensePaid(hashKey(key))).toBe(true)
    expect((await app.request('/premium/k/ra_notarealkeynotarealkey')).status).toBe(404)
  })
  test('free devices get one place within 3 miles; Premium gets more', async () => {
    const { app } = setup()
    const two = [{ name: 'Home', lat: 47.6, lon: -122.3, km: 2 }, { name: 'Work', lat: 47.62, lon: -122.33, km: 2 }]
    const free = await app.request('/api/v1/devices', json({ subscription, places: two }))
    expect(free.status).toBe(402)
    expect(((await free.json()) as any).premium_required).toBe(true)
    expect((await app.request('/api/v1/devices', json({ subscription, places: [{ ...two[0], km: 20 }] }))).status).toBe(402)
    expect((await app.request('/api/v1/devices', json({ subscription, places: two, premium_key: COMP }))).status).toBe(200)
  })
  test('history past a day needs a key', async () => {
    const { app, store } = setup()
    store.upsertIncidents([inc({ id: 'old', at: Date.now() - 3 * 86_400_000 })])
    const ids = async (h: Record<string, string> = {}) => ((await (await app.request('/api/v1/incidents?hours=168', { headers: h })).json()) as any).incidents.map((i: any) => i.id)
    expect(await ids()).toEqual([])
    expect(await ids({ 'x-premium-key': COMP })).toEqual(['old'])
  })
  test('only a signed webhook for a payment we started counts', async () => {
    const { app, store } = setup()
    store.recordPayment({ ref: 'pay_1', amount_cents: 499, chain: 'BTC', raw: {} })
    const body = JSON.stringify({ id: 'evt_1', data: { payment_id: 'pay_1', status: 'confirmed' } })
    const t = Math.floor(Date.now() / 1000)
    const sig = `t=${t},v1=${createHmac('sha256', 'whsec').update(`${t}.${body}`).digest('hex')}`
    expect((await app.request('/hooks/coinpay', { method: 'POST', body, headers: { 'x-coinpay-signature': 't=1,v1=00' } })).status).toBe(401)
    expect((await app.request('/hooks/coinpay', { method: 'POST', body, headers: { 'x-coinpay-signature': sig } })).status).toBe(200)
    expect(store.payment('pay_1')?.status).toBe('confirmed')
  })
})

describe('radio parsing', () => {
  test('state and county pages', () => {
    expect(parseStatePage('<a href="/listen/ctid/2972">Island</a>').get('island')).toBe('2972')
    expect(parseStatePage('<a class="portal-grid-card" href="/listen/ctid/2623"><span class="portal-grid-card-name">Harris</span><span>9</span></a>').get('harris')).toBe('2623')
    expect(parseCountyPage('<table class="listen-feed-table"><tr><td>no feeds here</td></tr></table>' + COUNTY).length).toBe(3)
    const feeds = parseCountyPage(COUNTY)
    expect(feeds.map((f) => f.id)).toEqual(['19037', '43916', '1'])
    expect(feeds[2]!.online).toBe(false)
    expect(normCounty('St. Louis County')).toBe('stlouis')
    expect(normCounty('Orleans Parish')).toBe('orleans')
  })
})

describe('cli and tui', () => {
  test('arguments', () => {
    const { pos, flags } = parseArgs(['47.6', '-122.3', '--km', '2', '--serious', '--json'])
    expect(pos).toEqual(['47.6', '-122.3'])
    expect(queryFrom(pos, flags)).toEqual({ lat: 47.6, lon: -122.3, km: 2, minSeverity: 3 })
    expect(() => queryFrom(['x', 'y'], {})).toThrow()
  })
  test('keys and fresh marks', () => {
    const s = initialState(3)
    absorb(s, [inc({ id: 'a' }) as any])
    expect(s.fresh.size).toBe(0)
    absorb(s, [inc({ id: 'a' }) as any, inc({ id: 'b' }) as any])
    expect([...s.fresh]).toEqual(['b'])
    expect(onKey(s, { name: '', key: '', char: '+' })).toBe('reload')
    expect(s.km).toBe(4.5)
    expect(onKey(s, { name: '', key: '', char: 'q' })).toBe('quit')
  })
})
