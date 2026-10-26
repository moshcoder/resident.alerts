import { afterAll, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Accounts } from '../src/accounts.js'
import { SOURCES } from '../src/cities.js'
import { CoinPayOAuth } from '../src/coinpay-oauth.js'
import { Community } from '../src/community.js'
import { Store } from '../src/db.js'
import type { Pusher } from '../src/push.js'
import { RadioFinder } from '../src/radio.js'
import { createApp } from '../src/server.js'

const dirs: string[] = []
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })))

/** A pretend CoinPay: checks the PKCE verifier against the challenge it was given, then says who you are. */
function fakeCoinPay() {
  const codes = new Map<string, { sub: string; email: string; challenge: string; redirect: string }>()
  const tokens = new Map<string, { sub: string; email: string }>()
  let who = { sub: 'cp-user-1', email: 'tony@example.com' }
  const f = (async (url: string, init: any = {}) => {
    const u = new URL(url)
    if (u.pathname === '/api/oauth/token') {
      const b = new URLSearchParams(init.body)
      const c = codes.get(b.get('code')!)
      const ok = c && b.get('client_secret') === 'secret' && b.get('redirect_uri') === c.redirect && createHash('sha256').update(b.get('code_verifier')!).digest('base64url') === c.challenge
      if (!ok) return Response.json({ error: 'invalid_grant' }, { status: 400 })
      codes.delete(b.get('code')!)
      const at = `at_${Math.random()}`
      tokens.set(at, c)
      return Response.json({ access_token: at, token_type: 'Bearer' })
    }
    if (u.pathname === '/api/oauth/userinfo') {
      const t = tokens.get(String(init.headers?.authorization ?? '').replace('Bearer ', ''))
      return t ? Response.json({ sub: t.sub, email: t.email, email_verified: false }) : Response.json({}, { status: 401 })
    }
    return new Response('nope', { status: 404 })
  }) as unknown as typeof fetch
  /** What CoinPay's consent screen would do: hand back a code bound to the challenge. */
  const consent = (authorizeUrl: string) => {
    const q = new URL(authorizeUrl).searchParams
    const code = `code_${Math.random().toString(36).slice(2)}`
    codes.set(code, { ...who, challenge: q.get('code_challenge')!, redirect: q.get('redirect_uri')! })
    return `/auth/coinpay/callback?code=${code}&state=${q.get('state')}`
  }
  return { f, consent, as: (sub: string, email: string) => (who = { sub, email }) }
}

function setup() {
  const store = new Store()
  const mail: { to: string; subject: string; text: string }[] = []
  const accounts = new Accounts(store.db, Date.now, ['boss@example.com'])
  dirs.push(mkdtempSync(join(tmpdir(), 'ra-oauth-')))
  const community = new Community(store.db, store, dirs[dirs.length - 1]!, { adminKey: 'admin-secret' })
  const cp = fakeCoinPay()
  const oauth = new CoinPayOAuth(store.db, { clientId: 'cp_test', clientSecret: 'secret', base: 'https://coinpay.test' }, cp.f)
  const pusher: Pusher = { enabled: true, publicKey: 'B', send: async () => true }
  const premium = { coinpay: null, chains: ['BTC'], cents: 499, comp: new Set<string>() }
  const app = createApp({ store, sources: SOURCES, pusher, radio: new RadioFinder(), premium, community, accounts, mail: async (m) => (mail.push(m), true), oauth, secureCookies: false })
  let cookie = ''
  const req = async (path: string, o: { form?: Record<string, string> } = {}) => {
    const r = await app.request(path, {
      method: o.form ? 'POST' : 'GET',
      headers: { 'x-real-ip': '1.2.3.4', 'sec-fetch-site': 'same-origin', ...(cookie ? { cookie } : {}), ...(o.form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}) },
      ...(o.form ? { body: new URLSearchParams(o.form).toString() } : {}),
    })
    const set = r.headers.get('set-cookie')
    if (set?.startsWith('ra_session=')) cookie = /^ra_session=;/.test(set) ? '' : set.split(';')[0]!
    return r
  }
  const coinpaySignIn = async () => {
    const start = await req('/auth/coinpay/start?next=/')
    expect(start.status).toBe(302)
    return req(cp.consent(start.headers.get('location')!))
  }
  const emailSignIn = async (email: string) => {
    await req('/signin', { form: { email, next: '/', news: '1' } })
    const link = mail.at(-1)!.text.match(/\/auth\/([A-Za-z0-9_-]+)/)![1]!
    await req(`/auth/${link}`, { form: { next: '/' } })
  }
  const me = async () => (await req('/api/v1/account')).json() as Promise<any>
  return { req, cp, accounts, mail, coinpaySignIn, emailSignIn, me, signOut: () => (cookie = '') }
}

describe('sign in with CoinPay', () => {
  test('the redirect carries PKCE S256 and our callback', async () => {
    const { req } = setup()
    const loc = new URL((await req('/auth/coinpay/start?next=/radio')).headers.get('location')!)
    expect(loc.origin + loc.pathname).toBe('https://coinpay.test/api/oauth/authorize')
    expect(loc.searchParams.get('code_challenge_method')).toBe('S256')
    expect(loc.searchParams.get('client_id')).toBe('cp_test')
    expect(loc.searchParams.get('redirect_uri')).toEndWith('/auth/coinpay/callback')
    expect(loc.searchParams.get('scope')).toBe('openid profile email')
    expect(await (await req('/signin')).text()).toContain('Sign in with CoinPay')
  })
  test('first sign-in makes an account (email unverified), the next finds it', async () => {
    const { coinpaySignIn, me, signOut } = setup()
    const r = await coinpaySignIn()
    expect(r.headers.get('location')).toBe('/account?welcome=1')
    const a = await me()
    expect(a).toMatchObject({ signed_in: true, email: null, coinpay: true })
    expect(a.display).toContain('tony@example.com (via CoinPay)')
    signOut()
    expect((await coinpaySignIn()).headers.get('location')).toBe('/')
    expect((await me()).display).toBe(a.display)
  })
  test('a state is good once', async () => {
    const { req, cp } = setup()
    const start = await req('/auth/coinpay/start')
    const cb = cp.consent(start.headers.get('location')!)
    expect((await req(cb)).status).toBe(302)
    expect((await req(cb.replace(/code=[^&]+/, 'code=other'))).status).toBe(400)
    expect((await req('/auth/coinpay/callback?code=x&state=forged')).status).toBe(400)
    expect((await req('/auth/coinpay/callback?error=access_denied')).status).toBe(400)
  })
  test('an email typed into CoinPay never opens the account that owns it', async () => {
    const { emailSignIn, coinpaySignIn, signOut, me, cp, accounts } = setup()
    await emailSignIn('boss@example.com')
    expect((await me()).premium).toBe(true)
    signOut()
    cp.as('cp-attacker', 'boss@example.com')
    await coinpaySignIn()
    const a = await me()
    expect(a.premium).toBe(false)
    expect(a.email).toBeNull()
    expect(accounts.count().users).toBe(2)
  })
  test('a CoinPay account proves an email; one that already has an account merges into it', async () => {
    const { req, coinpaySignIn, me, mail, accounts, signOut, emailSignIn } = setup()
    await emailSignIn('tony@example.com')
    signOut()
    await coinpaySignIn()
    expect((await me()).email).toBeNull()
    await req('/account', { form: { action: 'email', email: 'tony@example.com', news: '1' } })
    expect(mail.at(-1)!.subject).toContain('Confirm your email')
    const link = mail.at(-1)!.text.match(/\/auth\/([A-Za-z0-9_-]+)/)![1]!
    await req(`/auth/${link}`, { form: { next: '/account' } })
    const a = await me()
    expect(a.email).toBe('tony@example.com')
    expect(a.coinpay).toBe(true)
    expect(accounts.count().users).toBe(1)
    // And from now on, CoinPay signs you into that same account.
    signOut()
    await coinpaySignIn()
    expect((await me()).email).toBe('tony@example.com')
  })
  test('connect CoinPay from an email account', async () => {
    const { emailSignIn, coinpaySignIn, me, signOut } = setup()
    await emailSignIn('maria@example.com')
    const r = await coinpaySignIn()
    expect(r.headers.get('location')).toBe('/account?connected=1')
    signOut()
    await coinpaySignIn()
    expect((await me()).email).toBe('maria@example.com')
  })
  test('unverified CoinPay emails stay off the mailing list', async () => {
    const { coinpaySignIn, accounts } = setup()
    await coinpaySignIn()
    expect(accounts.newsCsv()).not.toContain('tony@example.com')
    expect(accounts.newsCsv()).not.toContain('coinpay:')
  })
})
