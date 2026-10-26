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
import { Accounts, createMailer, EMAIL, hasEmail, mailConfig, type Mailer, type User } from './accounts.js'
import { CoinPayOAuth, oauthConfig } from './coinpay-oauth.js'
import { CodeError, Codes, INVITE_CODE, REF_CODE } from './codes.js'
import { SOURCES } from './cities.js'
import { chpSource } from './chp.js'
import { Community } from './community.js'
import { mountCommunity } from './community-routes.js'
import { cleanKinds, cleanPlaces, MAX_PLACES, Store } from './db.js'
import { Geocoder } from './geocode.js'
import { aboutPage, accountPage, apiPage, confirmSigninPage, coveragePage, homePage, incidentPage, invitedPage, invitesPage, messagePage, premiumKeyPage, premiumPage, radioPage, signinPage, type Ctx } from './html.js'
import { startPitFooterRefresh } from './pit-footer.js'
import { createPusher, pushConfig, type Pusher } from './push.js'
import { RadioFinder } from './radio.js'
import { ringDescriptor, startRingFooterRefresh } from './ring-footer.js'
import { RING_PLACEHOLDER, ringBar, startRingRefresh, visitorOnMoshpit } from './ring.js'
import { KINDS, type Kind, type Source } from './sources.js'
import { FREE, hashKey, isPremium, KEY_SHAPE, limitsFor, PREMIUM, premiumConfig, price, readWebhook, SETTLED, startPremium, verifyWebhook, type PremiumConfig } from './premium.js'
import { VERSION } from './version.js'
import { ConditionsFinder, Hotspots } from './wildfire.js'
import { startWorker } from './worker.js'

export { VERSION }

const SELF = 'resident.alerts'
const DIRECT_ORIGIN = 'https://resident.alerts'
export const RELAY_ORIGIN = 'https://resident.alerts.pit.world'

const SECURITY_HEADERS: Record<string, string> = {
  'content-security-policy':
    "default-src 'none'; style-src 'self' 'unsafe-inline'; script-src 'self' https://crawlproof.com; img-src 'self' data: blob: https://tile.openstreetmap.org https://built.indie.pit.world https://pwamart.com; media-src 'self' blob:; connect-src 'self' https://crawlproof.com; worker-src 'self'; manifest-src 'self'; form-action 'self' https://coinpayportal.com; base-uri 'none'; frame-ancestors 'none'",
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
  oauth?: CoinPayOAuth
  hotspots?: Hotspots
  conditions?: ConditionsFinder
  secureCookies?: boolean
  fetch?: typeof fetch
}

const SESSION = 'ra_session'
/** An invite link someone opened, until they make an account (7 days). */
const INVITE = 'ra_invite'
/** The first affiliate link (?ref=) a visitor arrived through (30 days). */
const REF = 'ra_ref'
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

/** At most `max` points per ring, evenly sampled, the ring kept closed. */
export function thin(rings: [number, number][][], max: number): [number, number][][] {
  return rings.map((r) => {
    if (r.length <= max) return r
    const step = r.length / (max - 1)
    const out = Array.from({ length: max - 1 }, (_, n) => r[Math.floor(n * step)]!)
    out.push(r[0]!)
    return out
  })
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
  const layerLimit = new Limiter(60, 60_000)

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
  const displayEmail = (u: User) => (hasEmail(u) ? u.email : u.unverified_email ? `${u.unverified_email} (via CoinPay)` : 'your CoinPay account')
  const accountPremium = (u: User | null) => Boolean(deps.accounts && deps.accounts.premium(deps.premium, u))
  /** Limits from a key or the signed-in account, whichever is better. */
  const limitsOf = (c: Context, key: unknown) => (accountPremium(userOf(c)) ? PREMIUM : limitsFor(deps.premium, store, key))
  const ctxOf = (c: Context): Ctx => {
    const u = userOf(c)
    return { origin: origin(c), ...(u ? { user: { email: displayEmail(u), premium: accountPremium(u) } } : {}), accounts: Boolean(deps.accounts), coinpay: Boolean(deps.oauth) }
  }
  const ip = (c: Context) => c.req.header('x-real-ip') ?? 'local'
  const page = (c: Context, html: string, status = 200) => c.html(html.replace(RING_PLACEHOLDER, ringBar(SELF, direct(c))), status as 200)
  const CORS = { 'access-control-allow-origin': '*' }
  /** A Premium key from the API (header) or a form/body field. */
  const keyOf = (c: Context) => c.req.header('x-premium-key') ?? (c.req.header('authorization') ?? '').replace(/^Bearer\s+/i, '')
  const PRICE = price(deps.premium.cents)
  /** Credit codes and invites: they hang off accounts, so only with accounts on. */
  const codes = deps.accounts ? new Codes(store, deps.accounts, deps.premium) : null
  const cookieOpts = (c: Context, maxAge: number) => ({ httpOnly: true, secure: deps.secureCookies ?? https(c), sameSite: 'Lax' as const, path: '/', maxAge })
  /** A new account: spend the invite it came through and credit the affiliate link it arrived by. */
  const welcomeNew = async (c: Context, u: User, created: boolean) => {
    if (!codes) return
    const invite = getCookie(c, INVITE)
    if (invite && created) await codes.acceptInvite(invite, u).catch(() => null)
    if (invite) deleteCookie(c, INVITE, { path: '/' })
    const ref = getCookie(c, REF)
    if (ref && created) await codes.affiliates.attribute(ref, u.id).catch(() => null)
  }

  app.use('*', async (c, next) => {
    // Forms only from our own pages: a cross-site POST is refused before it reaches a handler.
    if (c.req.method === 'POST' && !c.req.path.startsWith('/api/') && !c.req.path.startsWith('/hooks/') && c.req.header('sec-fetch-site') === 'cross-site') {
      return c.text('cross-site request refused', 403)
    }
    await next()
    // A route that set its own (uploaded media sets a sandbox CSP) keeps it.
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) if (!c.res.headers.has(k)) c.header(k, v)
  })
  // Anyone arriving with ?ref=<affiliate code> is remembered for when they make an account (first touch wins).
  app.use('*', async (c, next) => {
    const ref = c.req.query('ref')
    if (codes && ref && REF_CODE.test(ref) && !getCookie(c, REF)) setCookie(c, REF, ref, cookieOpts(c, 30 * 86_400))
    await next()
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
  app.get('/llms.txt', (c) => c.text(`# resident.alerts\n\nLive 911 incidents (police, fire, medical, traffic) from US city open-data feeds, plus NWS warnings, USGS earthquakes, wildfires with perimeters (NIFC, CAL FIRE) and evacuation zones. Free, no key.\n\n- GET ${RELAY_ORIGIN}/api/v1/incidents?lat=&lon=&km=&hours=&kinds=&min_severity=\n- GET ${RELAY_ORIGIN}/api/v1/fires?lat=&lon=&km=\n- GET ${RELAY_ORIGIN}/api/v1/hotspots?s=&w=&n=&e=\n- GET ${RELAY_ORIGIN}/api/v1/conditions?lat=&lon=\n- GET ${RELAY_ORIGIN}/api/v1/incidents/{id}\n- GET ${RELAY_ORIGIN}/api/v1/radio?lat=&lon=\n- GET ${RELAY_ORIGIN}/api/v1/sources\n- MCP: bunx @profullstack/residentalerts mcp\n`))

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
  const redeemLimit = new Limiter(10, 10 * 60_000)
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
      const got = acc.spendLink(c.req.param('token'))
      if (!got) return page(c, confirmSigninPage(ctxOf(c), { token: '', next: '/account', ok: false }), 400)
      const u = got.user
      await welcomeNew(c, u, got.created)
      setCookie(c, SESSION, acc.newSession(u.id), { httpOnly: true, secure: deps.secureCookies ?? https(c), sameSite: 'Lax', path: '/', maxAge: 180 * 86_400 })
      return c.redirect(safeNext(f.next))
    })
    if (deps.oauth) {
      const oauth = deps.oauth
      app.get('/auth/coinpay/start', (c) => {
        const u = userOf(c)
        return c.redirect(oauth.start({ redirectUri: `${origin(c)}/auth/coinpay/callback`, next: safeNext(c.req.query('next') ?? '/'), linkUser: u?.id ?? null, news: c.req.query('news') === '1' }))
      })
      app.get('/auth/coinpay/callback', async (c) => {
        const q = c.req.query()
        c.header('cache-control', 'no-store')
        const fail = (message: string) => page(c, messagePage(ctxOf(c), { title: 'CoinPay sign-in did not finish', message }), 400)
        if (q.error) return fail(q.error === 'access_denied' ? 'You cancelled on CoinPay. Nothing changed.' : 'CoinPay said no. Try again.')
        if (!q.code || !q.state) return fail('That link is missing its code. Start again from Sign in.')
        const out = await oauth.finish(q.code, q.state)
        if ('error' in out) return fail(out.error)
        const r = acc.signInWithCoinPay(out.profile, out.linkUser)
        if ('error' in r) return fail(r.error)
        if (out.linkUser) return c.redirect('/account?connected=1')
        await welcomeNew(c, r.user, r.created)
        setCookie(c, SESSION, acc.newSession(r.user.id), { httpOnly: true, secure: deps.secureCookies ?? https(c), sameSite: 'Lax', path: '/', maxAge: 180 * 86_400 })
        return c.redirect(r.created ? '/account?welcome=1' : safeNext(out.next))
      })
    }
    app.post('/signout', (c) => {
      acc.endSession(getCookie(c, SESSION))
      deleteCookie(c, SESSION, { path: '/' })
      return c.redirect('/')
    })
    const accountView = (c: Context, u: User, extra: { flash?: string; error?: string } = {}, status = 200) =>
      page(c, accountPage(ctxOf(c), { email: displayEmail(u), verified: hasEmail(u), suggestEmail: u.unverified_email ?? '', coinpay: acc.identities(u.id).some((i) => i.provider === 'coinpay'), coinpayOn: Boolean(deps.oauth), premium: accountPremium(u), since: acc.premiumSince(u), news: Boolean(u.news), places: u.places.length, price: PRICE, ...extra }), status)
    app.get('/account', async (c) => {
      const u = userOf(c)
      if (!u) return c.redirect('/signin?next=/account')
      // Premium credits granted from outside a redemption (the redeem-credits CLI) switch on here.
      if (codes) await codes.applyPremium(u)
      const q = c.req.query()
      const flash = q.paid ? 'Payment sent. Premium switches on as soon as CoinPay confirms it (usually a minute or two), and we email you a receipt.' : q.connected ? 'CoinPay is connected: you can sign in with it from now on.' : q.welcome && !hasEmail(u) ? 'Signed in with CoinPay. Add your email below to get receipts and keep your account if you ever lose CoinPay access.' : ''
      return accountView(c, u, flash ? { flash } : {})
    })
    app.post('/account', async (c) => {
      const u = userOf(c)
      if (!u) return c.redirect('/signin?next=/account')
      const f = (await c.req.parseBody()) as Record<string, string>
      switch (f.action) {
        case 'news':
          acc.setNews(u.id, f.news === '1')
          return accountView(c, acc.user(u.id)!, { flash: f.news === '1' ? 'You will get occasional updates.' : 'No more updates. Sign-in links and receipts still arrive.' })
        case 'redeem':
          if (!codes) return c.redirect('/account')
          if (!redeemLimit.allow(`redeem:${u.id}`)) return accountView(c, u, { error: 'Too many tries. Wait a few minutes.' }, 429)
          try {
            return accountView(c, u, { flash: await codes.redeem(u, f.code) })
          } catch (e) {
            return accountView(c, u, { error: e instanceof Error ? e.message : String(e) }, e instanceof CodeError ? 400 : 500)
          }
        case 'key':
          return acc.attachKey(deps.premium, u.id, String(f.key ?? ''))
            ? accountView(c, u, { flash: 'Key attached: Premium is on your account.' })
            : accountView(c, u, { error: 'That key is not valid, or its payment has not confirmed yet.' }, 400)
        case 'email': {
          // A CoinPay-only account proves an email with the same one-time link.
          const email = String(f.email ?? '').trim().toLowerCase()
          if (hasEmail(u)) return c.redirect('/account')
          if (!EMAIL.test(email)) return accountView(c, u, { error: 'That does not look like an email address.' }, 400)
          if (!signinLimit.allow(`ip:${ip(c)}`) || acc.linksSince(email, Date.now() - 60 * 60_000) >= 5) return accountView(c, u, { error: 'Too many emails. Try again in an hour.' }, 429)
          const t = acc.newLink(email, f.news === '1', u.id)
          const sent = deps.mail ? await deps.mail({ to: email, subject: 'Confirm your email for resident.alerts', text: `Confirm this email for your resident.alerts account:\n\n${origin(c)}/auth/${t}?next=/account\n\nIt works once, for 20 minutes. If you didn't ask for this, ignore it.\n` }) : false
          return sent ? accountView(c, u, { flash: `We sent a link to ${email}. Open it to confirm.` }) : accountView(c, u, { error: 'We could not send the email just now.' }, 502)
        }
        case 'delete':
          if (f.sure !== '1') return accountView(c, u, { error: 'Tick the box to delete your account.' }, 400)
          acc.deleteUser(u.id)
          deleteCookie(c, SESSION, { path: '/' })
          return page(c, messagePage(ctxOf(c), { title: 'Account deleted', message: 'Your email and saved places are gone. Alerts on your devices keep working until you turn them off.' }))
      }
      return c.redirect('/account')
    })

    // ---- invites and affiliate links ------------------------------------------------
    // /i/ is an incident page, so an invite lands on /invite/<code>.
    app.get('/invite/:code', (c) => {
      const code = c.req.param('code')
      if (!INVITE_CODE.test(code)) return page(c, messagePage(ctxOf(c), { title: 'Not an invite', message: 'That invite link is not right.' }), 404)
      if (!userOf(c)) setCookie(c, INVITE, code, cookieOpts(c, 7 * 86_400))
      return page(c, invitedPage(ctxOf(c)))
    })
    const invitesView = async (c: Context, u: User, extra: { link?: string; error?: string } = {}, status = 200) =>
      page(c, invitesPage(ctxOf(c), { ...(await codes!.invitesView(u, RELAY_ORIGIN)), ...extra }), status)
    app.get('/invites', async (c) => {
      const u = userOf(c)
      if (!u) return c.redirect('/signin?next=/invites')
      return invitesView(c, u)
    })
    app.post('/invites', async (c) => {
      const u = userOf(c)
      if (!u) return c.redirect('/signin?next=/invites')
      const f = (await c.req.parseBody()) as Record<string, string>
      try {
        const invite = await codes!.affiliates.createInvite(u.id, String(f.note ?? '').slice(0, 80))
        return invitesView(c, u, { link: `${RELAY_ORIGIN}/invite/${invite.code}` })
      } catch (e) {
        const m = e instanceof Error ? e.message : String(e)
        return invitesView(c, u, { error: m === 'no invites left' ? 'You have used all your invites.' : m }, 400)
      }
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
    // Signed in when the payment lands: it goes on the account too.
    const u = userOf(c)
    if (u && state === 'paid' && deps.accounts) deps.accounts.attachKey(deps.premium, u.id, key)
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
    // Receipts go only to an email the buyer proved is theirs.
    if (u && hasEmail(u) && SETTLED.has(status) && !wasPaid && deps.mail) {
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
    // Zoomed out, an area's outline needs far fewer points than a street-level view: keep the payload phone-sized.
    const budget = q.km > 150 ? 60 : q.km > 40 ? 250 : 0
    const list = budget ? store.near(q).map((i) => (i.shape ? { ...i, shape: thin(i.shape, budget) } : i)) : store.near(q)
    return c.json({ count: list.length, incidents: list }, 200, { 'cache-control': 'public, max-age=20' })
  })
  // Watch Duty-style fire view: active fires and evacuation zones, however long ago they started.
  api.get('/fires', (c) => {
    const q = incidentQuery({ km: '150', limit: '1000', ...c.req.query(), hours: '24' }, 24)
    const list = store.near({ ...q, kinds: ['fire', 'hazard'], sinceMs: Date.now() }).filter((i) => i.source === 'wildfires' || i.source === 'evac' || /red flag|fire/i.test(i.title))
    return c.json({ count: list.length, fires: list.filter((i) => i.kind === 'fire'), evacuations: list.filter((i) => i.source === 'evac'), warnings: list.filter((i) => i.source === 'nws') }, 200, { 'cache-control': 'public, max-age=30' })
  })
  api.get('/hotspots', async (c) => {
    if (!deps.hotspots) return c.json({ error: 'hotspots are off on this server' }, 503)
    const s = numIn(c.req.query('s'), -90, 90), w = numIn(c.req.query('w'), -180, 180), n = numIn(c.req.query('n'), -90, 90), e = numIn(c.req.query('e'), -180, 180)
    if (s === undefined || w === undefined || n === undefined || e === undefined || s >= n || w >= e) return c.json({ error: 'send the box as s, w, n, e (degrees)' }, 400)
    if (!layerLimit.allow(`layer:${ip(c)}`)) return c.json({ error: 'slow down: 60 a minute' }, 429)
    try {
      const list = await deps.hotspots.inBox([s, w, n, e])
      return c.json({ count: list.length, hotspots: list, source: 'VIIRS (NASA FIRMS via Esri Living Atlas), last 48 hours' }, 200, { 'cache-control': 'public, max-age=300' })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return c.json({ error: /zoom in/.test(msg) ? msg : 'could not reach the hotspot layer just now' }, /zoom in/.test(msg) ? 400 : 502)
    }
  })
  api.get('/conditions', async (c) => {
    if (!deps.conditions) return c.json({ error: 'conditions are off on this server' }, 503)
    const lat = numIn(c.req.query('lat'), -90, 90)
    const lon = numIn(c.req.query('lon'), -180, 180)
    if (lat === undefined || lon === undefined) return c.json({ error: 'lat and lon are required' }, 400)
    if (!layerLimit.allow(`layer:${ip(c)}`)) return c.json({ error: 'slow down: 60 a minute' }, 429)
    try {
      return c.json(await deps.conditions.near(lat, lon), 200, { 'cache-control': 'public, max-age=600' })
    } catch {
      return c.json({ error: 'could not reach the weather service just now' }, 502)
    }
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

  type DeviceBody = { subscription?: { endpoint?: string; keys?: { p256dh?: string; auth?: string } }; endpoint?: string; auth?: string; places?: unknown; kinds?: unknown; min_severity?: unknown; premium_key?: string; id?: string; follow?: boolean }
  const body = async (c: Context) => ((await c.req.json().catch(() => ({}))) ?? {}) as DeviceBody
  const deviceView = (d: ReturnType<Store['device']>) => d && { places: d.places, kinds: d.kinds, min_severity: d.min_severity, follows: d.follows, created_at: d.created_at, last_push_at: d.last_push_at || null }

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
  /** Follow a fire (or any incident): every change to it, and its end, comes to this device. */
  api.post('/devices/follow', async (c) => {
    const b = await body(c)
    const d = b.endpoint && b.auth ? store.deviceFor(b.endpoint, b.auth) : null
    if (!d) return c.json({ error: 'turn on alerts on this device first' }, 404)
    const id = String(b.id ?? '')
    if (b.follow !== false && !store.incident(id)) return c.json({ error: 'no such incident' }, 404)
    const follows = store.follow(d.id, id, b.follow !== false)
    return typeof follows === 'string' ? c.json({ error: follows }, 400) : c.json({ ok: true, follows })
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
    return c.json({ signed_in: true, email: hasEmail(u) ? u.email : null, display: displayEmail(u), premium: accountPremium(u), places: u.places, news: Boolean(u.news), coinpay: deps.accounts!.identities(u.id).some((i) => i.provider === 'coinpay') })
  })
  // A key this browser kept from before it signed in joins the account.
  api.post('/account/key', async (c) => {
    const u = userOf(c)
    if (!u || !deps.accounts) return c.json({ error: 'sign in first' }, 401)
    const b = ((await c.req.json().catch(() => ({}))) ?? {}) as { key?: string }
    const attached = deps.accounts.attachKey(deps.premium, u.id, String(b.key ?? ''))
    return c.json({ attached, premium: accountPremium(u) }, attached ? 200 : 400)
  })
  /** Redeem a credit code for the signed-in account. */
  api.post('/redeem', async (c) => {
    const u = userOf(c)
    if (!u || !codes) return c.json({ error: 'sign in first' }, 401)
    if (!redeemLimit.allow(`redeem:${u.id}`)) return c.json({ error: 'too many tries; wait a few minutes' }, 429)
    const b = ((await c.req.json().catch(() => ({}))) ?? {}) as { code?: string }
    try {
      const message = await codes.redeem(u, b.code)
      return c.json({ ok: true, message, premium: accountPremium(u) })
    } catch (e) {
      return c.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, e instanceof CodeError ? 400 : 500)
    }
  })
  api.get('/invites', async (c) => {
    const u = userOf(c)
    if (!u || !codes) return c.json({ error: 'sign in first' }, 401)
    const v = await codes.invitesView(u, RELAY_ORIGIN)
    return c.json({ quota: v.quota, invites: v.invites, affiliate_link: v.affiliate })
  })
  api.post('/invites', async (c) => {
    const u = userOf(c)
    if (!u || !codes) return c.json({ error: 'sign in first' }, 401)
    const b = ((await c.req.json().catch(() => ({}))) ?? {}) as { note?: string }
    try {
      const invite = await codes.affiliates.createInvite(u.id, String(b.note ?? '').slice(0, 80))
      return c.json({ link: `${RELAY_ORIGIN}/invite/${invite.code}`, code: invite.code, expires_at: invite.expiresAt ? new Date(invite.expiresAt).toISOString() : null, left: (await codes.affiliates.quota(u.id)).left }, 201)
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e)
      return c.json({ error: m === 'no invites left' ? 'You have used all your invites.' : m }, 400)
    }
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
  const oc = oauthConfig(env)
  const oauth = oc ? new CoinPayOAuth(store.db, oc) : undefined
  const app = createApp({ store, sources, pusher, radio, premium: premiumConfig(env), community, accounts, mail, hotspots: new Hotspots(), conditions: new ConditionsFinder(), ...(oauth ? { oauth } : {}) })
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
