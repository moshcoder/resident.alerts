/**
 * The resident.alerts web server: the map app, incident pages, the open JSON
 * API, push registration, radio lookups, Premium, and the worker that reads the
 * feeds.
 *
 * resident.alerts is a Moshpit name. Visitors on Moshpit DNS reach
 * https://resident.alerts directly; everyone else comes through the pit.world
 * relay at https://resident.alerts.pit.world, which says so with an
 * x-moshpit-name header. Anything that leaves the box (push links, webhooks)
 * uses the relay, because nobody outside Moshpit can resolve the name.
 */
import { Database } from 'bun:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { Hono, type Context } from 'hono'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import { Accounts, createMailer, EMAIL, mailConfig, type Mailer, type User } from './accounts.js'
import { SOURCES } from './cities.js'
import { chpSource } from './chp.js'
import { Community } from './community.js'
import { mountCommunity } from './community-routes.js'
import { cleanKinds, cleanPlaces, MAX_PLACES, Store } from './db.js'
import { Geocoder } from './geocode.js'
import { aboutPage, accountPage, apiPage, confirmSigninPage, coveragePage, homePage, incidentPage, messagePage, premiumKeyPage, premiumPage, radioPage, signinPage, type Ctx } from './html.js'
import { startPitFooterRefresh } from './pit-footer.js'
import { createPusher, pushConfig, type Pusher } from './push.js'
import { RadioFinder } from './radio.js'
import { ringDescriptor, startRingFooterRefresh } from './ring-footer.js'
import { RING_PLACEHOLDER, ringBar, startRingRefresh, visitorOnMoshpit } from './ring.js'
import { KINDS, type Kind, type Source } from './sources.js'
import { FREE, hashKey, isPremium, KEY_SHAPE, limitsFor, PREMIUM, premiumConfig, price, readWebhook, SETTLED, startPremium, verifyWebhook, type PremiumConfig } from './premium.js'
import { VERSION } from './version.js'
import { startWorker } from './worker.js'

export { VERSION }

const SELF = 'resident.alerts'
const DIRECT_ORIGIN = 'https://resident.alerts'
export const RELAY_ORIGIN = 'https://resident.alerts.pit.world'

const SECURITY_HEADERS: Record<string, string> = {
  'content-security-policy':
    "default-src 'none'; style-src 'self' 'unsafe-inline'; script-src 'self' https://crawlproof.com; img-src 'self' data: blob: https://tile.openstreetmap.org https://built.indie.pit.world; media-src 'self' blob:; connect-src 'self' https://crawlproof.com; worker-src 'self'; manifest-src 'self'; form-action 'self' https://coinpayportal.com; base-uri 'none'; frame-ancestors 'none'",
  'referrer-policy': 'strict-origin-when-cross-origin',
  'x-content-type-options': 'nosniff',
  // The map asks for your location itself (in the browser); nothing else is used.
  'permissions-policy': 'interest-cohort=(), browsing-topics=(), camera=(), microphone=(), geolocation=(self)',
  'cross-origin-opener-policy': 'same-origin',
}

export type Deps = {
  store: Store
  sources: Source[]
  pusher: Pusher
  radio: RadioFinder
  premium: PremiumConfig
  community?: Community
  accounts?: Accounts
  mail?: Mailer
  secureCookies?: boolean
  fetch?: typeof fetch
}

const SESSION = 'ra_session'
const safeNext = (n: unknown) => (typeof n === 'string' && /^\/[A-Za-z0-9/_?=&%.:#-]*$/.test(n) && !n.startsWith('//') ? n : '/account')

class Limiter {
  private hits = new Map<string, { n: number; reset: number }>()
  constructor(private readonly max: number, private readonly windowMs: number) {}
  allow(key: string, now = Date.now()): boolean {
    const h = this.hits.get(key)
    if (!h || h.reset < now) {
      if (this.hits.size > 50_000) this.hits.clear()
      this.hits.set(key, { n: 1, reset: now + this.windowMs })
      return true
    }
    h.n += 1
    return h.n <= this.max
  }
}

const numIn = (v: unknown, lo: number, hi: number): number | undefined => {
  if (v === undefined || v === null || v === '') return undefined
  const n = Number(v)
  return Number.isFinite(n) && n >= lo && n <= hi ? n : undefined
}
const kindsIn = (v: unknown): Kind[] | undefined => {
  const list = String(v ?? '').split(',').map((s) => s.trim()).filter((k): k is Kind => KINDS.includes(k as Kind))
  return list.length ? list : undefined
}

/** Query string -> a near() call. Shared by the API and the pages. */
export function incidentQuery(q: Record<string, string | undefined>, maxHours = 24 * 30) {
  const lat = numIn(q.lat, -90, 90)
  const lon = numIn(q.lon, -180, 180)
  const hours = Math.min(numIn(q.hours, 0.05, 24 * 30) ?? 24, maxHours)
  return {
    ...(lat !== undefined && lon !== undefined ? { lat, lon } : {}),
    km: numIn(q.km, 0.1, 500) ?? 10,
    sinceMs: Date.now() - hours * 3600_000,
    ...(kindsIn(q.kinds) ? { kinds: kindsIn(q.kinds) } : {}),
    minSeverity: numIn(q.min_severity, 1, 3) ?? 1,
    limit: numIn(q.limit, 1, 1000) ?? 300,
    ...(q.source ? { source: q.source } : {}),
  }
}

export function createApp(deps: Deps) {
  const { store, pusher } = deps
  const app = new Hono()
  const apiLimit = new Limiter(120, 60_000)
  const radioLimit = new Limiter(20, 60_000)
  const deviceLimit = new Limiter(30, 60 * 60_000)
  const testLimit = new Limiter(5, 60 * 60_000)

  const direct = (c: Context) => visitorOnMoshpit(SELF, c.req.header('host'), c.req.header('x-moshpit-name'))
  const https = (c: Context) => (c.req.header('x-forwarded-proto') ?? 'https') === 'https'
  const origin = (c: Context) => (direct(c) && https(c) ? DIRECT_ORIGIN : RELAY_ORIGIN)
  /**
   * The signed-in account. A cookie only counts on a write when the request came
   * from our own pages: browsers send Sec-Fetch-Site, so a cross-site form or
   * fetch cannot act as you.
   */
  const userOf = (c: Context): User | null => {
    const acc = deps.accounts
    if (!acc) return null
    if (c.req.method !== 'GET' && c.req.method !== 'HEAD' && (c.req.header('sec-fetch-site') ?? 'same-origin') !== 'same-origin') return null
    return acc.session(getCookie(c, SESSION))
  }
  const accountPremium = (u: User | null) => Boolean(deps.accounts && deps.accounts.premium(deps.premium, u))
  /** Limits from a key or the signed-in account, whichever is better. */
  const limitsOf = (c: Context, key: unknown) => (accountPremium(userOf(c)) ? PREMIUM : limitsFor(deps.premium, store, key))
  const ctxOf = (c: Context): Ctx => {
    const u = userOf(c)
    return { origin: origin(c), ...(u ? { user: { email: u.email, premium: accountPremium(u) } } : {}), accounts: Boolean(deps.accounts) }
  }
  const ip = (c: Context) => c.req.header('x-real-ip') ?? 'local'
  const page = (c: Context, html: string, status = 200) => c.html(html.replace(RING_PLACEHOLDER, ringBar(SELF, direct(c))), status as 200)
  const CORS = { 'access-control-allow-origin': '*' }
  /** A Premium key from the API (header) or a form/body field. */
  const keyOf = (c: Context) => c.req.header('x-premium-key') ?? (c.req.header('authorization') ?? '').replace(/^Bearer\s+/i, '')
  const PRICE = price(deps.premium.cents)

  app.use('*', async (c, next) => {
    // Forms only from our own pages: a cross-site POST is refused before it reaches a handler.
    if (c.req.method === 'POST' && !c.req.path.startsWith('/api/') && !c.req.path.startsWith('/hooks/') && c.req.header('sec-fetch-site') === 'cross-site') {
      return c.text('cross-site request refused', 403)
    }
    await next()
    // A route that set its own (uploaded media sets a sandbox CSP) keeps it.
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) if (!c.res.headers.has(k)) c.header(k, v)
  })

  app.get('/health', (c) => c.json({ ok: true, version: VERSION, push: pusher.enabled, devices: store.countDevices(), sources: store.sourceStates().filter((s) => s.last_ok > Date.now() - 30 * 60_000).length }))
  app.get('/.well-known/openwebring.json', (c) => c.json(ringDescriptor(), 200, CORS))
  app.get('/robots.txt', (c) => c.text(`User-agent: *\nAllow: /\nDisallow: /api/\nSitemap: ${RELAY_ORIGIN}/sitemap.xml\n`))
  app.get('/sitemap.xml', (c) => {
    const paths = ['/', '/radio', '/coverage', '/about', '/api', '/premium']
    const recent = store.near({ sinceMs: Date.now() - 2 * 86_400_000, minSeverity: 3, limit: 500 })
    const urls = [...paths.map((p) => `${RELAY_ORIGIN}${p}`), ...recent.map((i) => `${RELAY_ORIGIN}/i/${encodeURIComponent(i.id)}`)]
    return c.body(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls.map((u) => `<url><loc>${u.replace(/&/g, '&amp;')}</loc></url>`).join('')}</urlset>`, 200, { 'content-type': 'application/xml' })
  })
  app.get('/llms.txt', (c) => c.text(`# resident.alerts\n\nLive 911 incidents (police, fire, medical, traffic) from US city open-data feeds, plus NWS warnings, USGS earthquakes and NIFC wildfires. Free, no key.\n\n- GET ${RELAY_ORIGIN}/api/v1/incidents?lat=&lon=&km=&hours=&kinds=&min_severity=\n- GET ${RELAY_ORIGIN}/api/v1/incidents/{id}\n- GET ${RELAY_ORIGIN}/api/v1/radio?lat=&lon=\n- GET ${RELAY_ORIGIN}/api/v1/sources\n- MCP: bunx @profullstack/residentalerts mcp\n`))

  const TYPES: Record<string, string> = { css: 'text/css; charset=utf-8', js: 'text/javascript; charset=utf-8', svg: 'image/svg+xml', png: 'image/png', webmanifest: 'application/manifest+json', html: 'text/html; charset=utf-8', crt: 'application/x-x509-ca-cert' }
  app.get('/:file{(style\\.css|app\\.js|community\\.js|sw\\.js|favicon\\.svg|icon-192\\.png|icon-512\\.png|manifest\\.webmanifest|offline\\.html|moshpit-root-ca\\.crt)}', async (c) => {
    const name = c.req.param('file')
    const file = Bun.file(new URL(`../public/${name}`, import.meta.url))
    const cache = name === 'sw.js' ? 'no-cache' : 'public, max-age=86400'
    return c.body(await file.arrayBuffer(), 200, { 'content-type': TYPES[name.split('.').pop()!]!, 'cache-control': cache })
  })
  app.get('/vendor/:file{(leaflet\\.js|leaflet\\.css)}', async (c) => {
    const name = c.req.param('file')
    return c.body(await Bun.file(new URL(`../public/vendor/${name}`, import.meta.url)).arrayBuffer(), 200, { 'content-type': TYPES[name.split('.').pop()!]!, 'cache-control': 'public, max-age=604800, immutable' })
  })
  app.get('/vendor/images/:file{[a-z0-9-]+\\.png}', async (c) => {
    const f = Bun.file(new URL(`../public/vendor/images/${c.req.param('file')}`, import.meta.url))
    return (await f.exists()) ? c.body(await f.arrayBuffer(), 200, { 'content-type': 'image/png', 'cache-control': 'public, max-age=604800' }) : c.notFound()
  })

  // ---- pages -------------------------------------------------------------------

  app.get('/', (c) =>
    page(c, homePage(ctxOf(c), { latest: store.near({ sinceMs: Date.now() - 24 * 3600_000, minSeverity: 3, limit: 25, kinds: ['police', 'fire', 'traffic', 'weather', 'quake', 'hazard'] }), push: pusher.enabled, vapid: pusher.publicKey, sources: deps.sources.length, price: PRICE })),
  )
  app.get('/i/:id', (c) => {
    const i = store.incident(c.req.param('id'))
    if (!i) return page(c, messagePage(ctxOf(c), { title: 'Not found', message: 'That incident is not in our records. We keep 30 days.' }), 404)
    const nearby = store.near({ lat: i.lat, lon: i.lon, km: 1.5, sinceMs: i.at - 24 * 3600_000, limit: 12 }).filter((n) => n.id !== i.id && !n.shape)
    return page(c, incidentPage(ctxOf(c), { i, nearby, source: deps.sources.find((s) => s.id === i.source) }))
  })
  app.get('/coverage', (c) => page(c, coveragePage(ctxOf(c), { sources: deps.sources, states: store.sourceStates(), counts: store.counts(Date.now() - 24 * 3600_000), devices: store.countDevices() })))
  app.get('/about', (c) => page(c, aboutPage(ctxOf(c), PRICE)))
  app.get('/api', (c) => page(c, apiPage(ctxOf(c))))
  app.get('/radio', async (c) => {
    const lat = numIn(c.req.query('lat'), -90, 90)
    const lon = numIn(c.req.query('lon'), -180, 180)
    if (lat === undefined || lon === undefined) return page(c, radioPage(ctxOf(c), {}))
    if (!radioLimit.allow(`radio:${ip(c)}`)) return page(c, radioPage(ctxOf(c), { lat, lon, error: 'Too many lookups. Try again in a minute.' }), 429)
    try {
      const radio = await deps.radio.near(lat, lon)
      return page(c, radioPage(ctxOf(c), { lat, lon, radio, ...(radio ? {} : { error: 'Radio listings cover the US only.' }) }))
    } catch {
      return page(c, radioPage(ctxOf(c), { lat, lon, error: 'Could not reach the radio directory just now. Try again in a minute.' }), 502)
    }
  })

  // ---- signing in (one-time email links) ---------------------------------------------
  const signinLimit = new Limiter(10, 60 * 60_000)
  if (deps.accounts) {
    const acc = deps.accounts
    app.get('/signin', (c) => {
      const next = safeNext(c.req.query('next'))
      if (userOf(c)) return c.redirect(next)
      return page(c, signinPage(ctxOf(c), { next }))
    })
    app.post('/signin', async (c) => {
      const f = (await c.req.parseBody()) as Record<string, string>
      const email = String(f.email ?? '').trim().toLowerCase()
      const next = safeNext(f.next)
      const news = f.news === '1'
      if (!EMAIL.test(email)) return page(c, signinPage(ctxOf(c), { next, error: 'That does not look like an email address.', email }), 400)
      if (!signinLimit.allow(`ip:${ip(c)}`) || acc.linksSince(email, Date.now() - 60 * 60_000) >= 5) return page(c, signinPage(ctxOf(c), { next, error: 'Too many sign-in emails. Try again in an hour.', email }), 429)
      const t = acc.newLink(email, news)
      const sent = deps.mail ? await deps.mail({ to: email, subject: 'Your resident.alerts sign-in link', text: `Sign in to resident.alerts:\n\n${origin(c)}/auth/${t}?next=${encodeURIComponent(next)}\n\nIt works once, for 20 minutes. If you didn't ask for this, ignore it.\n` }) : false
      if (!sent) return page(c, signinPage(ctxOf(c), { next, error: 'We could not send the email just now. Try again in a minute.', email }), 502)
      return page(c, signinPage(ctxOf(c), { next, sent: email }))
    })
    app.get('/auth/:token', (c) => {
      const ok = acc.linkValid(c.req.param('token'))
      c.header('cache-control', 'no-store')
      return page(c, confirmSigninPage(ctxOf(c), { token: c.req.param('token'), next: safeNext(c.req.query('next')), ok }), ok ? 200 : 400)
    })
    app.post('/auth/:token', async (c) => {
      const f = (await c.req.parseBody()) as Record<string, string>
      const u = acc.takeLink(c.req.param('token'))
      if (!u) return page(c, confirmSigninPage(ctxOf(c), { token: '', next: '/account', ok: false }), 400)
      setCookie(c, SESSION, acc.newSession(u.id), { httpOnly: true, secure: deps.secureCookies ?? https(c), sameSite: 'Lax', path: '/', maxAge: 180 * 86_400 })
      return c.redirect(safeNext(f.next))
    })
    app.post('/signout', (c) => {
      acc.endSession(getCookie(c, SESSION))
      deleteCookie(c, SESSION, { path: '/' })
      return c.redirect('/')
    })
    const accountView = (c: Context, u: User, extra: { flash?: string; error?: string } = {}, status = 200) =>
      page(c, accountPage(ctxOf(c), { email: u.email, premium: accountPremium(u), since: acc.premiumSince(u), news: Boolean(u.news), places: u.places.length, price: PRICE, ...extra }), status)
    app.get('/account', (c) => {
      const u = userOf(c)
      if (!u) return c.redirect('/signin?next=/account')
      return accountView(c, u, c.req.query('paid') ? { flash: 'Payment sent. Premium switches on as soon as CoinPay confirms it (usually a minute or two), and we email you a receipt.' } : {})
    })
    app.post('/account', async (c) => {
      const u = userOf(c)
      if (!u) return c.redirect('/signin?next=/account')
      const f = (await c.req.parseBody()) as Record<string, string>
      switch (f.action) {
        case 'news':
          acc.setNews(u.id, f.news === '1')
          return accountView(c, acc.user(u.id)!, { flash: f.news === '1' ? 'You will get occasional updates.' : 'No more updates. Sign-in links and receipts still arrive.' })
        case 'key':
          return acc.attachKey(deps.premium, u.id, String(f.key ?? ''))
            ? accountView(c, u, { flash: 'Key attached: Premium is on your account.' })
            : accountView(c, u, { error: 'That key is not valid, or its payment has not confirmed yet.' }, 400)
        case 'delete':
          if (f.sure !== '1') return accountView(c, u, { error: 'Tick the box to delete your account.' }, 400)
          acc.deleteUser(u.id)
          deleteCookie(c, SESSION, { path: '/' })
          return page(c, messagePage(ctxOf(c), { title: 'Account deleted', message: 'Your email and saved places are gone. Alerts on your devices keep working until you turn them off.' }))
      }
      return c.redirect('/account')
    })
  }

  // ---- Premium ---------------------------------------------------------------------

  const premiumView = (c: Context, error?: string, status = 200) => page(c, premiumPage(ctxOf(c), { chains: deps.premium.chains, enabled: Boolean(deps.premium.coinpay), price: PRICE, needSignin: Boolean(deps.accounts) && !userOf(c), ...(error ? { error } : {}) }), status)
  app.get('/premium', (c) => premiumView(c))
  app.get('/tip', (c) => c.redirect('/premium', 301))
  app.post('/premium', async (c) => {
    const f = (await c.req.parseBody()) as Record<string, string>
    const u = userOf(c)
    // Premium belongs to an account, so a lost browser never loses it.
    if (deps.accounts && !u) return c.redirect('/signin?next=/premium')
    if (u && accountPremium(u)) return c.redirect('/account')
    try {
      const out = await startPremium(deps.premium, store, { chain: String(f.chain ?? ''), successUrl: (key) => (u ? `${origin(c)}/account?paid=1` : `${RELAY_ORIGIN}/premium/k/${key}`), cancelUrl: `${origin(c)}/premium`, ...(u ? { userId: u.id } : {}) }, deps.fetch)
      return c.redirect(out.checkoutUrl)
    } catch (e) {
      return premiumView(c, e instanceof Error ? e.message : String(e), 400)
    }
  })
  // Where CoinPay sends the buyer back: the key, once the payment has settled.
  app.get('/premium/k/:key', (c) => {
    const key = c.req.param('key')
    const state = KEY_SHAPE.test(key) ? (deps.premium.comp.has(hashKey(key)) ? 'paid' : store.licenseState(hashKey(key))) : null
    if (!state) return page(c, messagePage(ctxOf(c), { title: 'Not a key we sold', message: 'Check the link, or buy Premium again from the Premium page.' }), 404)
    c.header('cache-control', 'no-store')
    return page(c, premiumKeyPage(ctxOf(c), { key, paid: state === 'paid', price: PRICE }))
  })
  app.post('/hooks/coinpay', async (c) => {
    const raw = await c.req.text()
    const cp = deps.premium.coinpay
    if (!cp || !verifyWebhook(cp.webhookSecret, raw, c.req.header('x-coinpay-signature') ?? c.req.header('coinpay-signature'))) return c.json({ error: 'bad signature' }, 401)
    let payload: unknown
    try {
      payload = JSON.parse(raw)
    } catch {
      return c.json({ error: 'bad json' }, 400)
    }
    const { ref, status } = readWebhook(payload)
    const known = ref ? store.payment(String(ref)) : null
    if (!known) return c.json({ ok: true, ignored: 'unknown payment' })
    const wasPaid = store.licensePaid(known.license_hash ?? '-')
    store.settlePayment(known.ref, status, payload, SETTLED.has(status))
    // A receipt, once, to the account that paid.
    const u = known.user_id && deps.accounts ? deps.accounts.user(known.user_id) : null
    if (u && SETTLED.has(status) && !wasPaid && deps.mail) {
      await deps.mail({ to: u.email, subject: 'resident.alerts Premium is on', text: `Thanks for buying resident.alerts Premium (${PRICE}, for life).\n\nIt is tied to your account (${u.email}): sign in on any phone or computer and it is there. Up to 25 alert places, 50 miles each, and 30 days of history.\n\n${RELAY_ORIGIN}/account\n` })
    }
    return c.json({ ok: true, status, settled: SETTLED.has(status) })
  })

  // ---- the open API ----------------------------------------------------------------

  const api = new Hono()
  api.use('*', async (c, next) => {
    if (c.req.method === 'OPTIONS') return c.body(null, 204, { ...CORS, 'access-control-allow-methods': 'GET, POST, DELETE', 'access-control-allow-headers': 'content-type' })
    if (!apiLimit.allow(`api:${ip(c)}`)) return c.json({ error: 'slow down: 120 requests a minute' }, 429, CORS)
    await next()
    for (const [k, v] of Object.entries(CORS)) c.header(k, v)
  })

  api.get('/incidents', (c) => {
    // History past a day is Premium; without a key the window quietly stops at 24 hours.
    const q = incidentQuery(c.req.query(), limitsOf(c, keyOf(c)).hours)
    const list = store.near(q)
    return c.json({ count: list.length, incidents: list }, 200, { 'cache-control': 'public, max-age=20' })
  })
  api.get('/incidents/:id', (c) => {
    const i = store.incident(c.req.param('id'))
    return i ? c.json({ ...i, page: `${RELAY_ORIGIN}/i/${encodeURIComponent(i.id)}` }) : c.json({ error: 'not found' }, 404)
  })
  api.get('/sources', (c) => {
    const states = new Map(store.sourceStates().map((s) => [s.id, s]))
    const counts = store.counts(Date.now() - 24 * 3600_000)
    return c.json({
      sources: deps.sources.map((s) => ({
        id: s.id, name: s.name, area: s.area, center: s.center, km: s.km, kinds: s.kinds, homepage: s.homepage, city: s.km < 1000,
        last_ok: states.get(s.id)?.last_ok || null, last_error: states.get(s.id)?.last_error || null,
        last_24h: counts.filter((n) => n.source === s.id).reduce((a, n) => a + n.n, 0),
      })),
    })
  })
  api.get('/radio', async (c) => {
    const lat = numIn(c.req.query('lat'), -90, 90)
    const lon = numIn(c.req.query('lon'), -180, 180)
    if (lat === undefined || lon === undefined) return c.json({ error: 'lat and lon are required' }, 400)
    if (!radioLimit.allow(`radio:${ip(c)}`)) return c.json({ error: 'slow down: 20 radio lookups a minute' }, 429)
    try {
      const r = await deps.radio.near(lat, lon)
      return r ? c.json(r, 200, { 'cache-control': 'public, max-age=300' }) : c.json({ error: 'radio listings cover the US only' }, 404)
    } catch {
      return c.json({ error: 'could not reach the radio directory just now' }, 502)
    }
  })

  api.get('/vapid', (c) => c.json({ enabled: pusher.enabled, publicKey: pusher.publicKey }))
  api.post('/premium/check', async (c) => {
    const b = ((await c.req.json().catch(() => ({}))) ?? {}) as { key?: string }
    const premium = isPremium(deps.premium, store, b.key) || accountPremium(userOf(c))
    return c.json({ premium, limits: premium ? PREMIUM : FREE, price: PRICE })
  })

  type DeviceBody = { subscription?: { endpoint?: string; keys?: { p256dh?: string; auth?: string } }; endpoint?: string; auth?: string; places?: unknown; kinds?: unknown; min_severity?: unknown; premium_key?: string }
  const body = async (c: Context) => ((await c.req.json().catch(() => ({}))) ?? {}) as DeviceBody
  const deviceView = (d: ReturnType<Store['device']>) => d && { places: d.places, kinds: d.kinds, min_severity: d.min_severity, created_at: d.created_at, last_push_at: d.last_push_at || null }

  /** Turn alerts on, or change places/kinds: the subscription itself is the credential. */
  api.post('/devices', async (c) => {
    if (!pusher.enabled) return c.json({ error: 'push is not set up on this server' }, 503)
    if (!deviceLimit.allow(`dev:${ip(c)}`)) return c.json({ error: 'slow down' }, 429)
    const b = await body(c)
    const sub = b.subscription
    if (!sub?.endpoint || !/^https:\/\/[^\s]+$/.test(sub.endpoint) || sub.endpoint.length > 1000 || !sub.keys?.p256dh || !sub.keys.auth) return c.json({ error: 'send the PushSubscription as "subscription"' }, 400)
    const places = cleanPlaces(b.places ?? [])
    if (typeof places === 'string') return c.json({ error: places }, 400)
    if (!places.length) return c.json({ error: 'add at least one place' }, 400)
    const limits = limitsOf(c, b.premium_key)
    if (places.length > limits.places || places.some((p) => p.km > limits.km + 0.05)) {
      return c.json({ error: `Free alerts cover ${FREE.places} place within ${Math.round(FREE.km * 0.621371)} miles. Premium (${PRICE} once, for life) covers ${MAX_PLACES} places up to 50 miles.`, premium_required: true }, 402)
    }
    // Changing an existing device needs its current auth secret, which only that browser has.
    const existing = store.device(sub.endpoint)
    if (existing && existing.auth !== sub.keys.auth) return c.json({ error: 'that subscription belongs to another device' }, 403)
    const d = store.saveDevice({ endpoint: sub.endpoint, p256dh: String(sub.keys.p256dh), auth: String(sub.keys.auth) }, { places, kinds: cleanKinds(b.kinds), min_severity: Number(b.min_severity ?? 1) })
    return c.json({ ok: true, device: deviceView(d) })
  })
  api.post('/devices/lookup', async (c) => {
    const b = await body(c)
    const d = b.endpoint && b.auth ? store.deviceFor(b.endpoint, b.auth) : null
    return d ? c.json({ device: deviceView(d) }) : c.json({ error: 'not found' }, 404)
  })
  api.post('/devices/test', async (c) => {
    const b = await body(c)
    const d = b.endpoint && b.auth ? store.deviceFor(b.endpoint, b.auth) : null
    if (!d) return c.json({ error: 'not found' }, 404)
    if (!testLimit.allow(`test:${d.id}`)) return c.json({ error: 'five tests an hour' }, 429)
    const ok = await pusher.send(d, { title: '🔔 resident.alerts is on', body: `Watching ${d.places.length} place${d.places.length === 1 ? '' : 's'}. This is what an alert looks like.`, url: '/', tag: 'test' })
    return c.json({ ok })
  })
  api.delete('/devices', async (c) => {
    const b = await body(c)
    const d = b.endpoint && b.auth ? store.deviceFor(b.endpoint, b.auth) : null
    if (d) store.deleteDevice(d.endpoint)
    return c.json({ ok: true, deleted: Boolean(d) })
  })

  // ---- the account, for the app ----------------------------------------------------
  api.get('/account', (c) => {
    const u = userOf(c)
    if (!u) return c.json({ signed_in: false }, 401)
    return c.json({ signed_in: true, email: u.email, premium: accountPremium(u), places: u.places, news: Boolean(u.news) })
  })
  api.put('/account/places', async (c) => {
    const u = userOf(c)
    if (!u || !deps.accounts) return c.json({ error: 'sign in first' }, 401)
    const b = ((await c.req.json().catch(() => ({}))) ?? {}) as { places?: unknown }
    const lim = limitsOf(c, undefined)
    const places = deps.accounts.setPlaces(u.id, Array.isArray(b.places) ? b.places.slice(0, lim.places) : [])
    return typeof places === 'string' ? c.json({ error: places }, 400) : c.json({ places })
  })
  api.get('/admin/emails', (c) => {
    if (!deps.community?.isAdmin(c.req.header('x-admin-key')) || !deps.accounts) return c.json({ error: 'forbidden' }, 403)
    return c.body(deps.accounts.newsCsv(), 200, { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': 'attachment; filename="resident-alerts-emails.csv"' })
  })

  if (deps.community) mountCommunity(app, api, { store, community: deps.community, pusher, ...(deps.accounts ? { userOf, banUser: (id: string) => deps.accounts!.ban(id) } : {}) })
  app.route('/api/v1', api)

  app.notFound((c) => page(c, messagePage(ctxOf(c), { title: 'Not found', message: 'Nothing lives at this address.' }), 404))
  return app
}

export async function serve(opts: { port?: number } = {}) {
  const env = process.env
  const dbPath = env.DATABASE_PATH ?? `${env.STATE_DIR ?? '.'}/resident-alerts.db`
  if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true })
  const store = new Store(dbPath)
  const pusher = createPusher(pushConfig(env), store)
  const cacheDb = new Database(dbPath === ':memory:' ? ':memory:' : dbPath.replace(/\.db$/, '') + '-geocache.db', { create: true })
  const geo = new Geocoder(cacheDb)
  const sources = env.CHP === 'off' ? SOURCES : [...SOURCES, chpSource(cacheDb)]
  const radio = new RadioFinder()
  const community = new Community(store.db, store, join(dirname(dbPath === ':memory:' ? './x' : dbPath), 'media'), {
    maxBytes: Number(env.MEDIA_MAX_GB ?? 5) * 1024 ** 3,
    ...(env.ADMIN_KEY ? { adminKey: env.ADMIN_KEY } : {}),
    ...(env.COMMUNITY_SECRET ? { secret: env.COMMUNITY_SECRET } : {}),
  })
  setInterval(() => community.prune(30), 6 * 3600_000).unref?.()
  const accounts = new Accounts(store.db, Date.now, (env.ADMIN_EMAILS ?? '').split(/[\s,]+/))
  const mail = createMailer(mailConfig(env))
  const app = createApp({ store, sources, pusher, radio, premium: premiumConfig(env), community, accounts, mail })
  // The relay hostname, so pit.world serves the Moshpit footer template.
  startPitFooterRefresh('resident.alerts.pit.world')
  startRingFooterRefresh()
  startRingRefresh()
  if (env.WORKER !== 'off') startWorker({ store, sources, pusher, geo, log: console.log })
  const port = opts.port ?? Number(env.PORT ?? 8806)
  return Bun.serve({ port, hostname: env.HOST ?? '127.0.0.1', fetch: app.fetch, idleTimeout: 30 })
}

if (import.meta.main) {
  const s = await serve()
  console.log(`resident.alerts ${VERSION} listening on http://${s.hostname}:${s.port}`)
}
