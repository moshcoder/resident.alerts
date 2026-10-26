import { afterAll, describe, expect, test } from 'bun:test'
import { createHmac } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Accounts } from '../src/accounts.js'
import { SOURCES } from '../src/cities.js'
import { Community } from '../src/community.js'
import { Store } from '../src/db.js'
import { hashKey, newKey } from '../src/premium.js'
import type { Pusher } from '../src/push.js'
import { RadioFinder } from '../src/radio.js'
import { createApp } from '../src/server.js'

const dirs: string[] = []
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })))

type Opts = { method?: string; form?: Record<string, string>; json?: unknown; body?: string; site?: string; noCookie?: boolean; headers?: Record<string, string> }

function setup(coinpayFetch?: typeof fetch) {
  const store = new Store()
  const mail: { to: string; subject: string; text: string }[] = []
  const accounts = new Accounts(store.db, Date.now, ['boss@example.com'])
  dirs.push(mkdtempSync(join(tmpdir(), 'ra-acct-')))
  const community = new Community(store.db, store, dirs[dirs.length - 1]!, { adminKey: 'admin-secret' })
  const pusher: Pusher = { enabled: true, publicKey: 'B', send: async () => true }
  const comp = newKey()
  const premium = { coinpay: { baseUrl: 'https://coinpay.test', apiKey: 'k', businessId: 'b', webhookSecret: 'whsec' }, chains: ['BTC'], cents: 499, comp: new Set([hashKey(comp)]) }
  const app = createApp({ store, sources: SOURCES, pusher, radio: new RadioFinder(), premium, community, accounts, mail: async (m) => (mail.push(m), true), secureCookies: false, ...(coinpayFetch ? { fetch: coinpayFetch } : {}) })
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
  const signIn = async (email: string, news = true) => {
    await req('/signin', { form: { email, next: '/', ...(news ? { news: '1' } : {}) } })
    const link = mail.at(-1)!.text.match(/\/auth\/([A-Za-z0-9_-]+)/)![1]!
    expect((await req(`/auth/${link}`)).status).toBe(200)
    expect((await req(`/auth/${link}`, { form: { next: '/' } })).status).toBe(302)
    return link
  }
  return { store, accounts, mail, req, signIn, comp, signOut: () => (cookie = '') }
}

const signed = (body: string) => {
  const t = Math.floor(Date.now() / 1000)
  return `t=${t},v1=${createHmac('sha256', 'whsec').update(`${t}.${body}`).digest('hex')}`
}

describe('accounts', () => {
  test('sign in with an emailed link that works once', async () => {
    const { req, signIn, mail } = setup()
    expect((await req('/account')).status).toBe(302)
    const link = await signIn('Tony@Example.com')
    expect(mail[0]!.subject).toContain('sign-in link')
    expect(mail[0]!.to).toBe('tony@example.com')
    expect((await (await req('/api/v1/account')).json()) as any).toMatchObject({ signed_in: true, email: 'tony@example.com', premium: false, news: true })
    expect(await (await req('/account')).text()).toContain('tony@example.com')
    expect((await req(`/auth/${link}`, { form: { next: '/' }, noCookie: true })).status).toBe(400)
    await req('/signout', { form: {} })
    expect((await req('/api/v1/account')).status).toBe(401)
  })
  test('a cross-site request never acts as you', async () => {
    const { req, signIn } = setup()
    await signIn('tony@example.com')
    expect((await req('/api/v1/account/places', { method: 'PUT', json: { places: [{ lat: 1, lon: 1 }] }, site: 'cross-site' })).status).toBe(401)
    expect((await req('/api/v1/account/places', { method: 'PUT', json: { places: [{ name: 'Home', lat: 37.23, lon: -121.97, km: 2 }] } })).status).toBe(200)
    expect(((await (await req('/api/v1/account')).json()) as any).places[0].name).toBe('Home')
  })
  test('admins have Premium without paying', async () => {
    const { req, signIn } = setup()
    await signIn('boss@example.com')
    expect(((await (await req('/api/v1/account')).json()) as any).premium).toBe(true)
    expect(((await (await req('/api/v1/premium/check', { json: {} })).json()) as any).premium).toBe(true)
    expect(await (await req('/account')).text()).toContain('★ Premium')
  })
  test('Premium needs an account; the payment lands on it, with one receipt', async () => {
    let sent: any = null
    const coinpay = (async (_u: string, init: any) => ((sent = JSON.parse(init.body)), Response.json({ payment: { id: 'pay_7' } }))) as unknown as typeof fetch
    const { req, signIn, mail, store } = setup(coinpay)
    expect((await req('/premium', { form: { chain: 'BTC' } })).headers.get('location')).toBe('/signin?next=/premium')
    await signIn('buyer@example.com', false)
    expect((await req('/premium', { form: { chain: 'BTC' } })).headers.get('location')).toBe('https://coinpay.test/pay/pay_7')
    expect(sent.success_url).toEndWith('/account?paid=1')
    expect(store.payment('pay_7')?.user_id).toBeTruthy()
    const body = JSON.stringify({ data: { payment_id: 'pay_7', status: 'confirmed' } })
    const hook = () => req('/hooks/coinpay', { body, site: 'cross-site', noCookie: true, headers: { 'x-coinpay-signature': signed(body) } })
    expect((await hook()).status).toBe(200)
    expect((await hook()).status).toBe(200)
    expect(mail.filter((m) => m.subject.includes('Premium is on'))).toHaveLength(1)
    expect(((await (await req('/api/v1/account')).json()) as any).premium).toBe(true)
    // Already Premium: the page says so instead of selling it again.
    expect((await req('/premium', { form: { chain: 'BTC' } })).headers.get('location')).toBe('/account')
  })
  test('a key bought (or given) without an account can be attached', async () => {
    const { req, signIn, comp } = setup()
    await signIn('friend@example.com')
    expect((await (await req('/account', { form: { action: 'key', key: 'ra_notpaidnotpaidnotpaid1' } })).text())).toContain('not valid')
    expect((await (await req('/account', { form: { action: 'key', key: comp } })).text())).toContain('Key attached')
    expect(((await (await req('/api/v1/account')).json()) as any).premium).toBe(true)
  })
  test('posting needs an account; the name follows you to a new device', async () => {
    const { req, signIn, signOut } = setup()
    expect((await req('/api/v1/residents', { json: { name: 'Tony' } })).status).toBe(401)
    await signIn('tony@example.com')
    const first = (await (await req('/api/v1/residents', { json: { name: 'Tony' } })).json()) as any
    signOut()
    await signIn('tony@example.com')
    const second = (await (await req('/api/v1/residents', { json: {} })).json()) as any
    expect(second.resident.id).toBe(first.resident.id)
    expect(second.token).not.toBe(first.token)
    const post = await req('/api/v1/chat', { json: { lat: 1, lon: 1, text: 'hello' }, headers: { authorization: `Bearer ${second.token}` } })
    expect(post.status).toBe(201)
  })
  test('the opt-in list and deleting an account', async () => {
    const { req, signIn, signOut, accounts } = setup()
    await signIn('yes@example.com', true)
    signOut()
    await signIn('no@example.com', false)
    const csv = await (await req('/api/v1/admin/emails', { headers: { 'x-admin-key': 'admin-secret' } })).text()
    expect(csv).toContain('yes@example.com')
    expect(csv).not.toContain('no@example.com')
    expect((await req('/api/v1/admin/emails')).status).toBe(403)
    await req('/account', { form: { action: 'delete', sure: '1' } })
    expect(accounts.byEmail('no@example.com')).toBeNull()
  })
})
