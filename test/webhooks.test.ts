import { describe, expect, test } from 'bun:test'
import { createHmac } from 'node:crypto'
import { Credits, sqliteStore as creditStore } from '@profullstack/redeem-credits'
import { verifySignature } from '@profullstack/webhooks'
import { Accounts } from '../src/accounts.js'
import { SOURCES } from '../src/cities.js'
import { Store } from '../src/db.js'
import { AccountAlerts, createHooks, incidentData, WEBHOOK_EVENTS } from '../src/hooks.js'
import { hashKey, newKey } from '../src/premium.js'
import type { Pusher } from '../src/push.js'
import { RadioFinder } from '../src/radio.js'
import { createApp } from '../src/server.js'
import { accountWebhooks } from '../src/worker.js'
import { AlertsClient } from '../src/client.js'
import { main } from '../src/cli.js'
import { inc } from './store.test.js'

type Opts = { method?: string; form?: Record<string, string>; json?: unknown; body?: string; site?: string; headers?: Record<string, string>; noCookie?: boolean }
type Got = { url: string; headers: Headers; body: string }

const ORIGIN = 'https://resident.alerts.pit.world'
const HOME = { name: 'Home', lat: 37.23, lon: -121.97, km: 3 }

function setup() {
  const store = new Store()
  const mail: { to: string; text: string }[] = []
  const accounts = new Accounts(store.db, Date.now, [])
  const got: Got[] = []
  // A unit-test receiver: nothing leaves the process.
  const receiver = (async (url: string | URL, init?: RequestInit) => {
    got.push({ url: String(url), headers: new Headers(init?.headers), body: String(init?.body ?? '') })
    return new Response(null, { status: 204 })
  }) as unknown as typeof fetch
  const hooks = createHooks(store.db, { source: ORIGIN, fetch: receiver, guard: { lookup: async () => ['93.184.216.34'] }, log: () => {} })
  const alerts = new AccountAlerts(store.db, hooks, ORIGIN)
  const pusher: Pusher = { enabled: true, publicKey: 'B', send: async () => true }
  const comp = newKey()
  const premium = { coinpay: { baseUrl: 'https://coinpay.test', apiKey: 'k', businessId: 'b', webhookSecret: 'whsec' }, chains: ['BTC'], cents: 499, comp: new Set([hashKey(comp)]) }
  const app = createApp({ store, sources: SOURCES, pusher, radio: new RadioFinder(), premium, accounts, hooks, alerts, mail: async (m) => (mail.push(m), true), secureCookies: false })
  let cookie = ''
  const req = async (path: string, o: Opts = {}) => {
    const r = await app.request(path, {
      method: o.method ?? (o.form || o.json || o.body ? 'POST' : 'GET'),
      headers: {
        'x-real-ip': '1.2.3.4',
        'sec-fetch-site': o.site ?? 'same-origin',
        ...(cookie && !o.noCookie ? { cookie } : {}),
        ...(o.json ? { 'content-type': 'application/json' } : {}),
        ...(o.form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
        ...(o.headers ?? {}),
      },
      ...(o.form ? { body: new URLSearchParams(o.form).toString() } : o.json ? { body: JSON.stringify(o.json) } : o.body ? { body: o.body } : {}),
    })
    const set = r.headers.get('set-cookie')
    if (set?.startsWith('ra_session=')) cookie = /^ra_session=;/.test(set) ? '' : set.split(';')[0]!
    return r
  }
  const signIn = async (email: string) => {
    cookie = ''
    await req('/signin', { form: { email, next: '/' } })
    const link = mail.at(-1)!.text.match(/\/auth\/([A-Za-z0-9_-]+)/)![1]!
    await req(`/auth/${link}`, { form: { next: '/' } })
    return accounts.byEmail(email)!
  }
  /** Signed in: an API key from the account page, then everything else with it and no cookie. */
  const apiKey = async () => (await (await req('/account', { form: { action: 'apikey' } })).text()).match(/rak_[A-Za-z0-9_-]+/)![0]
  const bearer = (key: string) => ({ authorization: `Bearer ${key}` })
  return { store, accounts, hooks, alerts, req, signIn, apiKey, bearer, got, comp }
}

const events = (got: Got[]) => got.map((g) => JSON.parse(g.body) as { type: string; data: any; subject?: string; source: string })

describe('customer webhooks', () => {
  test('the API answers 401 without a key, and to a wrong one', async () => {
    const { req } = setup()
    expect((await req('/api/v1/webhooks')).status).toBe(401)
    expect((await req('/api/v1/webhooks', { headers: { authorization: 'Bearer rak_nopenopenopenopenopenope' } })).status).toBe(401)
    expect((await req('/api/v1/webhooks', { headers: { 'x-premium-key': newKey() } })).status).toBe(401)
    expect((await req('/api/v1/webhooks/x/test', { method: 'POST' })).status).toBe(401)
  })

  test('an account key manages webhooks: create, list, secret, rotate, test, delete', async () => {
    const { req, signIn, apiKey, bearer, got } = setup()
    await signIn('tony@example.com')
    const key = await apiKey()
    const h = bearer(key)
    const list0 = (await (await req('/api/v1/webhooks', { headers: h, noCookie: true })).json()) as any
    expect(list0).toEqual({ endpoints: [], event_types: WEBHOOK_EVENTS })
    const bad = await req('/api/v1/webhooks', { json: { url: 'https://hooks.example.com/ra', events: ['room.*'] }, headers: h, noCookie: true })
    expect(bad.status).toBe(400)
    expect((await req('/api/v1/webhooks', { json: { url: 'http://hooks.example.com/ra' }, headers: h, noCookie: true })).status).toBe(400)
    const made = (await (await req('/api/v1/webhooks', { json: { url: 'https://hooks.example.com/ra', events: ['alert.*'] }, headers: h, noCookie: true })).json()) as any
    expect(made.secret).toStartWith('whsec_')
    const id = made.endpoint.id
    expect(((await (await req(`/api/v1/webhooks/${id}/secret`, { headers: h, noCookie: true })).json()) as any).secret).toBe(made.secret)
    const rotated = (await (await req(`/api/v1/webhooks/${id}/rotate`, { method: 'POST', headers: h, noCookie: true })).json()) as any
    expect(rotated.secret).not.toBe(made.secret)
    const t = (await (await req(`/api/v1/webhooks/${id}/test`, { method: 'POST', headers: h, noCookie: true })).json()) as any
    expect(t.ok).toBe(true)
    expect(events(got)[0]!.type).toBe('webhook.test')
    expect(verifySignature({ headers: got[0]!.headers, body: got[0]!.body, secret: rotated.secret }).ok).toBe(true)
    // Making a new API key retires the old one.
    const key2 = await apiKey()
    expect((await req('/api/v1/webhooks', { headers: h, noCookie: true })).status).toBe(401)
    expect((await req(`/api/v1/webhooks/${id}`, { method: 'DELETE', headers: bearer(key2), noCookie: true })).status).toBe(200)
    expect(((await (await req('/api/v1/webhooks', { headers: bearer(key2), noCookie: true })).json()) as any).endpoints).toEqual([])
  })

  test("one account never sees another's webhooks", async () => {
    const { req, signIn, apiKey, bearer } = setup()
    await signIn('a@example.com')
    const ka = await apiKey()
    const made = (await (await req('/api/v1/webhooks', { json: { url: 'https://hooks.example.com/a' }, headers: bearer(ka), noCookie: true })).json()) as any
    await signIn('b@example.com')
    const kb = await apiKey()
    expect(((await (await req('/api/v1/webhooks', { headers: bearer(kb), noCookie: true })).json()) as any).endpoints).toEqual([])
    expect((await req(`/api/v1/webhooks/${made.endpoint.id}/secret`, { headers: bearer(kb), noCookie: true })).status).toBe(404)
    expect((await req(`/api/v1/webhooks/${made.endpoint.id}`, { method: 'DELETE', headers: bearer(kb), noCookie: true })).status).toBe(404)
  })

  test('a Premium key that belongs to an account works as its API key; a cross-site cookie does not', async () => {
    const { req, signIn, comp } = setup()
    await signIn('tony@example.com')
    expect((await req('/api/v1/webhooks', { headers: { 'x-premium-key': comp }, noCookie: true })).status).toBe(401)
    await req('/account', { form: { action: 'key', key: comp } })
    expect((await req('/api/v1/webhooks', { headers: { 'x-premium-key': comp }, noCookie: true })).status).toBe(200)
    // The session counts from our own pages only.
    expect((await req('/api/v1/webhooks')).status).toBe(200)
    expect((await req('/api/v1/webhooks', { json: { url: 'https://hooks.example.com/x' }, site: 'cross-site' })).status).toBe(401)
  })

  test('the account page adds, tests, shows, rotates and removes webhooks', async () => {
    const { req, signIn, got, hooks, accounts } = setup()
    const u = await signIn('tony@example.com')
    const page = await (await req('/account')).text()
    expect(page).toContain('id="webhooks"')
    expect(page).toContain('alert.issued')
    const added = await (await req('/account/webhooks/add', { form: { url: 'https://hooks.example.com/ra', events: 'alert.issued alert.ended' } })).text()
    const secret = added.match(/whsec_[A-Za-z0-9+/=]+/)![0]
    const [w] = await hooks.listEndpoints(u.id)
    expect(w!.events).toEqual(['alert.issued', 'alert.ended'])
    expect(await (await req('/account/webhooks/secret', { form: { id: w!.id } })).text()).toContain(secret)
    expect(await (await req('/account/webhooks/test', { form: { id: w!.id } })).text()).toContain('Test delivered')
    expect(got).toHaveLength(1)
    expect(await (await req('/account/webhooks/rotate', { form: { id: w!.id } })).text()).not.toContain(secret)
    expect((await req('/account/webhooks/delete', { form: { id: w!.id }, site: 'cross-site' })).status).toBe(403)
    expect(await (await req('/account/webhooks/delete', { form: { id: w!.id } })).text()).toContain('Webhook removed')
    expect(await hooks.listEndpoints(u.id)).toEqual([])
    // Deleting the account takes its webhooks with it.
    await req('/account/webhooks/add', { form: { url: 'https://hooks.example.com/ra' } })
    accounts.deleteUser(u.id)
    expect(await hooks.listEndpoints(u.id)).toEqual([])
  })

  test("alerts go to the account whose places they are in, signed, with nobody else's details", async () => {
    const { req, signIn, apiKey, bearer, alerts, hooks, got, accounts } = setup()
    const a = await signIn('a@example.com')
    await req('/api/v1/account/places', { method: 'PUT', json: { places: [HOME] } })
    const made = (await (await req('/api/v1/webhooks', { json: { url: 'https://hooks.example.com/a' }, headers: bearer(await apiKey()), noCookie: true })).json()) as any
    // Someone far away with a webhook, and someone nearby without one.
    const b = await signIn('b@example.com')
    accounts.setPlaces(b.id, [{ name: 'Seattle', lat: 47.61, lon: -122.33, km: 3 }])
    await hooks.createEndpoint(b.id, { url: 'https://hooks.example.com/b' })
    const c = await signIn('c@example.com')
    accounts.setPlaces(c.id, [HOME])

    const near = inc({ id: 'scc:1', kind: 'fire', severity: 3, title: 'Structure fire', lat: 37.231, lon: -121.969 })
    const old = inc({ id: 'scc:old', lat: 37.231, lon: -121.969, at: Date.now() - 3 * 3600_000 })
    const report = inc({ id: 'community:r1', source: 'community', kind: 'fire', title: 'Brush fire by the trail (resident report)', area: 'Resident report', address: '', lat: 37.232, lon: -121.968 })
    expect(await alerts.issued([near, old, report])).toBe(2)
    expect(await alerts.issued([near])).toBe(0)
    await hooks.drain()
    expect(got.map((g) => g.url)).toEqual(['https://hooks.example.com/a', 'https://hooks.example.com/a'])
    for (const g of got) expect(verifySignature({ headers: g.headers, body: g.body, secret: made.secret }).ok).toBe(true)
    const [first, second] = events(got)
    expect(first!.type).toBe('alert.issued')
    expect(first!.source).toBe(ORIGIN)
    expect(first!.subject).toBe('incident:scc:1')
    expect(first!.data.place).toEqual({ name: 'Home', distance_km: expect.any(Number) })
    expect(first!.data.incident.page).toBe(`${ORIGIN}/i/scc%3A1`)
    // Only the public record: no reporter, no other account, no device.
    expect(Object.keys(second!.data).sort()).toEqual(['incident', 'place'])
    expect(Object.keys(second!.data.incident).sort()).toEqual(['address', 'api', 'area', 'area_outline', 'at', 'detail', 'id', 'kind', 'lat', 'lon', 'page', 'severity', 'source', 'title'])
    for (const g of got) for (const s of ['b@example.com', 'c@example.com', 'Seattle', 'a@example.com', a.id]) expect(g.body).not.toContain(s)

    // Changes and ends go only to who heard about it, each state once.
    got.length = 0
    const grown = { ...near, detail: '2 alarm' }
    expect(await alerts.changed([grown, inc({ id: 'elsewhere:9' })], [])).toBe(1)
    expect(await alerts.changed([grown], [])).toBe(0)
    expect(await alerts.changed([], [{ ...near, ended_at: Date.now() }])).toBe(1)
    await hooks.drain()
    expect(events(got).map((e) => e.type)).toEqual(['alert.updated', 'alert.ended'])
    expect(events(got)[1]!.data.incident.ended_at).toBeString()
  })

  test("the worker's hand-off: a fire that grows into a place is issued, not updated, and errors stay out of the way", async () => {
    const { alerts, hooks, accounts, got } = setup()
    const u = accounts.ensureUser('a@example.com')
    accounts.setPlaces(u.id, [HOME])
    await hooks.createEndpoint(u.id, { url: 'https://hooks.example.com/a', events: ['alert.*'] })
    const fire = inc({ id: 'wildfires:X', source: 'wildfires', kind: 'fire', lat: 37.5, lon: -121.97, at: Date.now() - 5 * 86_400_000, shape: [[[37.3, -122], [37.3, -121.9], [37.24, -121.95], [37.3, -122]]] })
    expect(await accountWebhooks(alerts, [], [fire], [])).toBe(1)
    await hooks.drain()
    expect(events(got).map((e) => e.type)).toEqual(['alert.issued'])
    const broken = { issued: async () => { throw new Error('db gone') }, changed: async () => 0 } as unknown as AccountAlerts
    const logs: unknown[] = []
    expect(await accountWebhooks(broken, [fire], [], [], (m) => logs.push(m))).toBe(0)
    expect(String(logs[0])).toContain('db gone')
  })

  test('premium.activated when a payment for the account settles, once; and for a credit code', async () => {
    const { req, signIn, store, hooks, got } = setup()
    const u = await signIn('tony@example.com')
    await hooks.createEndpoint(u.id, { url: 'https://hooks.example.com/a', events: ['premium.*'] })
    store.recordPayment({ ref: 'pay1', amount_cents: 499, chain: 'SOL', raw: {}, license_hash: hashKey(newKey()), user_id: u.id })
    const settle = (status: string) => {
      const body = JSON.stringify({ type: 'payment.confirmed', data: { payment_id: 'pay1', status } })
      const t = Math.floor(Date.now() / 1000)
      return req('/hooks/coinpay', { body, site: 'cross-site', noCookie: true, headers: { 'x-coinpay-signature': `t=${t},v1=${createHmac('sha256', 'whsec').update(`${t}.${body}`).digest('hex')}` } })
    }
    expect((await settle('pending')).status).toBe(200)
    expect((await settle('confirmed')).status).toBe(200)
    expect((await settle('completed')).status).toBe(200)
    await hooks.drain()
    const e = events(got)
    expect(e.map((x) => x.type)).toEqual(['premium.activated'])
    expect(e[0]!.data).toMatchObject({ via: 'payment', lifetime: true, chain: 'SOL', amount_usd: 4.99 })

    // A premium credit (code or grant) on another account switches on at its account page.
    got.length = 0
    const v = await signIn('vip@example.com')
    await hooks.createEndpoint(v.id, { url: 'https://hooks.example.com/v' })
    await new Credits(creditStore(store.db as never)).grant(v.id, { unit: 'premium', amount: 1 }, 'support')
    expect((await req('/account')).status).toBe(200)
    await new Promise((r) => setTimeout(r, 10))
    await hooks.drain()
    expect(got.map((g) => [g.url, JSON.parse(g.body).type, JSON.parse(g.body).data.via])).toEqual([['https://hooks.example.com/v', 'premium.activated', 'credit-code']])
  })
})

describe('CLI', () => {
  test('residentalerts webhook add / webhooks / test / rm, with the API key', async () => {
    const { req, signIn, apiKey, got } = setup()
    await signIn('tony@example.com')
    const key = await apiKey()
    const viaApp = (async (url: string | URL, init?: RequestInit) => req(new URL(String(url)).pathname, { method: init?.method ?? 'GET', headers: (init?.headers ?? {}) as Record<string, string>, noCookie: true, ...(init?.body ? { body: String(init.body) } : {}) })) as unknown as typeof fetch
    const client = new AlertsClient(ORIGIN, viaApp, key)
    const out: string[] = []
    expect(await main(['webhook', 'add', 'https://hooks.example.com/cli', '--events', 'alert.issued,alert.ended'], (s) => out.push(s), client)).toBe(0)
    expect(out[0]).toContain('signing secret: whsec_')
    const id = out[0]!.split(' ')[0]!
    out.length = 0
    expect(await main(['webhooks'], (s) => out.push(s), client)).toBe(0)
    expect(out[0]).toContain('https://hooks.example.com/cli  alert.issued,alert.ended')
    expect(await main(['webhook', 'test', id], (s) => out.push(s), client)).toBe(0)
    expect(got).toHaveLength(1)
    expect(await main(['webhook', 'rm', id], (s) => out.push(s), client)).toBe(0)
    expect(await main(['webhooks'], () => {}, new AlertsClient(ORIGIN, viaApp, ''))).toBe(1)
  })
})

describe('payloads', () => {
  test('incidentData keeps to the public record', () => {
    const d = incidentData(inc({ id: 'x:1', shape: [[[1, 1], [1, 2], [2, 2], [1, 1]]] }), ORIGIN, { name: 'Work', km: 1.23456 })
    expect(d.place).toEqual({ name: 'Work', distance_km: 1.23 })
    expect(d.incident.area_outline).toBe(true)
    expect(d.incident).not.toHaveProperty('shape')
  })
})
