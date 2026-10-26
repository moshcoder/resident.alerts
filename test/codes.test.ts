import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Credits, sqliteStore } from '@profullstack/redeem-credits'
import { Accounts } from '../src/accounts.js'
import { SOURCES } from '../src/cities.js'
import { Community } from '../src/community.js'
import { Store } from '../src/db.js'
import type { Pusher } from '../src/push.js'
import { RadioFinder } from '../src/radio.js'
import { createApp } from '../src/server.js'

const dirs: string[] = []
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })))

type Opts = { method?: string; form?: Record<string, string>; json?: unknown }

function setup() {
  const store = new Store()
  const mail: { to: string; subject: string; text: string }[] = []
  const accounts = new Accounts(store.db, Date.now, [])
  dirs.push(mkdtempSync(join(tmpdir(), 'ra-codes-')))
  const community = new Community(store.db, store, dirs.at(-1)!, {})
  const pusher: Pusher = { enabled: true, publicKey: 'B', send: async () => true }
  const premium = { coinpay: null, chains: ['BTC'], cents: 499, comp: new Set<string>() }
  const app = createApp({ store, sources: SOURCES, pusher, radio: new RadioFinder(), premium, community, accounts, mail: async (m) => (mail.push(m), true), secureCookies: false })
  const credits = new Credits(sqliteStore(store.db as never))

  /** One browser: its own cookie jar. */
  const browser = () => {
    const jar = new Map<string, string>()
    const req = async (path: string, o: Opts = {}) => {
      const r = await app.request(path, {
        method: o.method ?? (o.form || o.json ? 'POST' : 'GET'),
        headers: {
          'x-real-ip': '1.2.3.4',
          'sec-fetch-site': 'same-origin',
          ...(jar.size ? { cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; ') } : {}),
          ...(o.json ? { 'content-type': 'application/json' } : {}),
          ...(o.form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
        },
        ...(o.form ? { body: new URLSearchParams(o.form).toString() } : o.json ? { body: JSON.stringify(o.json) } : {}),
      })
      for (const set of r.headers.getSetCookie()) {
        const [kv] = set.split(';')
        const [k, v] = kv!.split('=') as [string, string]
        if (!v || /max-age=0/i.test(set)) jar.delete(k)
        else jar.set(k, v)
      }
      return r
    }
    const signIn = async (email: string) => {
      await req('/signin', { form: { email, next: '/account' } })
      const token = mail.at(-1)!.text.match(/\/auth\/([A-Za-z0-9_-]+)/)![1]!
      expect((await req(`/auth/${token}`, { form: { next: '/account' } })).status).toBe(302)
      return accounts.byEmail(email)!
    }
    const me = async () => (await (await req('/api/v1/account')).json()) as any
    return { req, signIn, me, jar }
  }
  return { store, accounts, credits, browser }
}

describe('credit codes', () => {
  test('a premium code switches on lifetime Premium, through the purchase path', async () => {
    const { browser, credits, store } = setup()
    const b = browser()
    const u = await b.signIn('ann@example.com')
    expect((await b.me()).premium).toBe(false)
    const { code } = await credits.mint({ grant: { unit: 'premium', amount: 1 }, label: 'test' })
    const r = await b.req('/account', { form: { action: 'redeem', code: code.toLowerCase() } })
    expect(r.status).toBe(200)
    expect(await r.text()).toContain('Premium is on your account')
    expect((await b.me()).premium).toBe(true)
    // One source of truth: a settled $0 payment on the account, and the credit spent.
    const row = store.db.query("SELECT amount_cents, chain, paid_at FROM payments WHERE user_id = ?").get(u.id) as any
    expect(row).toMatchObject({ amount_cents: 0, chain: 'credit-code' })
    expect(row.paid_at).toBeGreaterThan(0)
    expect(await credits.balance(u.id, 'premium')).toBe(0)
  })

  test('a used code and a made-up code are refused with a reason', async () => {
    const { browser, credits } = setup()
    const { code } = await credits.mint({ grant: { unit: 'premium', amount: 1 } })
    const a = browser()
    await a.signIn('a@example.com')
    expect((await a.req('/api/v1/redeem', { json: { code } })).status).toBe(200)
    // Already Premium: refused before the code is touched.
    const again = await a.req('/api/v1/redeem', { json: { code } })
    expect(again.status).toBe(400)
    expect(((await again.json()) as any).error).toContain('already have Premium')
    const b = browser()
    await b.signIn('b@example.com')
    const used = await b.req('/api/v1/redeem', { json: { code } })
    expect(used.status).toBe(400)
    expect(((await used.json()) as any).error).toBe('That code has been used.')
    const bad = await b.req('/account', { form: { action: 'redeem', code: 'CR-AAAA-BBBB-CCCC-DDDD' } })
    expect(bad.status).toBe(400)
    expect(await bad.text()).toContain('That code is not valid.')
    expect((await b.me()).premium).toBe(false)
    expect((await browser().req('/api/v1/redeem', { json: { code } })).status).toBe(401)
  })

  test('a premium credit granted outside a redemption switches on at the account page', async () => {
    const { browser, credits } = setup()
    const b = browser()
    const u = await b.signIn('c@example.com')
    await credits.grant(u.id, { unit: 'premium', amount: 1 }, 'support')
    expect((await b.req('/account')).status).toBe(200)
    expect((await b.me()).premium).toBe(true)
  })
})

describe('invites', () => {
  test('three per person; an invite is accepted once, by a new account only', async () => {
    const { browser, accounts, store } = setup()
    const inviter = browser()
    const host = await inviter.signIn('host@example.com')
    const made = await inviter.req('/api/v1/invites', { json: { note: 'for dan' } })
    expect(made.status).toBe(201)
    const { link, code, left } = (await made.json()) as any
    expect(left).toBe(2)
    expect(link).toEndWith(`/invite/${code}`)

    const guest = browser()
    expect((await guest.req(`/invite/${code}`)).status).toBe(200)
    expect(guest.jar.get('ra_invite')).toBe(code)
    const dan = await guest.signIn('dan@example.com')
    expect(guest.jar.has('ra_invite')).toBe(false)
    const used = store.db.query('SELECT * FROM aff_invites').all() as any[]
    expect(used.filter((i) => i.used_by === dan.id)).toHaveLength(1)

    // The same link a second time does nothing for another new account.
    const late = browser()
    await late.req(`/invite/${code}`)
    const eve = await late.signIn('eve@example.com')
    expect((store.db.query('SELECT COUNT(*) AS n FROM aff_invites WHERE used_by = ?').get(eve.id) as any).n).toBe(0)

    // An existing account opening an invite does not spend it.
    await inviter.req('/api/v1/invites', { json: {} })
    const third = ((await (await inviter.req('/api/v1/invites', { json: {} })).json()) as any).code
    const old = browser()
    await old.signIn('host2@example.com')
    await old.req('/signout', { form: {} })
    await old.req(`/invite/${third}`)
    await old.signIn('host2@example.com')
    expect((store.db.query('SELECT used_by FROM aff_invites WHERE used_by IS NOT NULL').all() as any[]).length).toBe(1)

    // Quota spent: a fourth is refused.
    const fourth = await inviter.req('/api/v1/invites', { json: {} })
    expect(fourth.status).toBe(400)
    expect(((await fourth.json()) as any).error).toBe('You have used all your invites.')
    expect(await (await inviter.req('/invites')).text()).toContain('<b>0</b> of 3')
    expect(accounts.user(host.id)).toBeTruthy()
  })

  test('?ref= is remembered first-touch and credited to a new account', async () => {
    const { browser, store } = setup()
    const a = browser()
    await a.signIn('aff@example.com')
    const aff = ((await (await a.req('/api/v1/invites')).json()) as any).affiliate_link as string
    const ref = new URL(aff).searchParams.get('ref')!
    const b = browser()
    await b.req(`/?ref=${ref}`)
    await b.req('/about?ref=someone-else')
    expect(b.jar.get('ra_ref')).toBe(ref)
    const newbie = await b.signIn('new@example.com')
    const tables = (store.db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'aff_%'").all() as any[]).map((t) => t.name)
    const attr = tables.find((t) => /attrib/.test(t))!
    const row = store.db.query(`SELECT * FROM ${attr}`).all() as any[]
    expect(JSON.stringify(row)).toContain(newbie.id)
  })
})
