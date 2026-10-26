/**
 * Accounts: sign in with your email (a one-time link, no password).
 *
 * An account keeps what used to live only in one browser: Premium (bought while
 * signed in, or a key attached later), your alert places, and your name in the
 * community. Posting, uploading and buying need an account; the map, radio and
 * one alert place never do.
 *
 * Links and sessions are stored as hashes. A link works once, for 20 minutes,
 * and is spent by a POST from the page it opens (mail scanners only GET).
 */
import type { Database } from 'bun:sqlite'
import { createHash, randomBytes } from 'node:crypto'
import { cleanPlaces, type Place } from './db.js'
import { hashKey, KEY_SHAPE, type PremiumConfig } from './premium.js'

export type User = { id: string; email: string; created_at: number; news: number; places: Place[]; banned: number }
export type MailConfig = { apiKey: string; from: string } | null

const sha = (s: string) => createHash('sha256').update(s).digest('hex')
const rand = (n = 24) => randomBytes(n).toString('base64url')
export const EMAIL = /^[^\s@<>()",;]{1,64}@[^\s@<>()",;]{1,190}\.[a-z]{2,}$/i
export const LINK_MS = 20 * 60_000
export const SESSION_MS = 180 * 86_400_000

type Row = Record<string, any>
const toUser = (r: Row): User => ({ id: r.id, email: r.email, created_at: r.created_at, news: r.news, places: JSON.parse(r.places || '[]'), banned: r.banned })

export class Accounts {
  readonly admins: Set<string>
  constructor(readonly db: Database, readonly now: () => number = Date.now, admins: string[] = []) {
    this.admins = new Set(admins.map((e) => e.trim().toLowerCase()).filter(Boolean))
    db.exec(`
      CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL, last_login_at INTEGER NOT NULL DEFAULT 0, news INTEGER NOT NULL DEFAULT 1, places TEXT NOT NULL DEFAULT '[]', banned INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS login_links (hash TEXT PRIMARY KEY, email TEXT NOT NULL, news INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL, used_at INTEGER);
      CREATE INDEX IF NOT EXISTS login_links_email ON login_links(email, created_at);
      CREATE TABLE IF NOT EXISTS sessions (hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS user_licenses (user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, license_hash TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (user_id, license_hash));
    `)
  }

  // ---- links + sessions -----------------------------------------------------------

  linksSince(email: string, sinceMs: number): number {
    return (this.db.query('SELECT COUNT(*) AS n FROM login_links WHERE email = ? AND created_at >= ?').get(email, sinceMs) as Row).n
  }
  newLink(email: string, news: boolean): string {
    const token = rand()
    this.db.query('INSERT INTO login_links (hash, email, news, created_at) VALUES (?, ?, ?, ?)').run(sha(token), email.toLowerCase(), news ? 1 : 0, this.now())
    this.db.query('DELETE FROM login_links WHERE created_at < ?').run(this.now() - 7 * 86_400_000)
    return token
  }
  linkValid(token: string): boolean {
    const r = this.db.query('SELECT created_at, used_at FROM login_links WHERE hash = ?').get(sha(token)) as Row | null
    return Boolean(r && !r.used_at && this.now() - r.created_at <= LINK_MS)
  }
  /** Spend a link: the account (made on first sign-in), or null if it is used up or old. */
  takeLink(token: string): User | null {
    const h = sha(token)
    const r = this.db.query('SELECT email, news, created_at, used_at FROM login_links WHERE hash = ?').get(h) as Row | null
    if (!r || r.used_at || this.now() - r.created_at > LINK_MS) return null
    if (this.db.query('UPDATE login_links SET used_at = ? WHERE hash = ? AND used_at IS NULL').run(this.now(), h).changes !== 1) return null
    const u = this.ensureUser(r.email, Boolean(r.news))
    return u.banned ? null : u
  }
  ensureUser(email: string, news = true): User {
    const e = email.toLowerCase()
    this.db.query('INSERT OR IGNORE INTO users (id, email, created_at, news) VALUES (?, ?, ?, ?)').run(rand(8), e, this.now(), news ? 1 : 0)
    this.db.query('UPDATE users SET last_login_at = ? WHERE email = ?').run(this.now(), e)
    return this.byEmail(e)!
  }
  byEmail(email: string): User | null {
    const r = this.db.query('SELECT * FROM users WHERE email = ?').get(email.toLowerCase()) as Row | null
    return r ? toUser(r) : null
  }
  user(id: string): User | null {
    const r = this.db.query('SELECT * FROM users WHERE id = ?').get(id) as Row | null
    return r ? toUser(r) : null
  }
  newSession(userId: string): string {
    const sid = rand(32)
    this.db.query('INSERT INTO sessions (hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)').run(sha(sid), userId, this.now(), this.now() + SESSION_MS)
    return sid
  }
  session(sid: string | undefined): User | null {
    if (!sid || sid.length < 20) return null
    const r = this.db.query('SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.hash = ? AND s.expires_at > ?').get(sha(sid), this.now()) as Row | null
    return r && !r.banned ? toUser(r) : null
  }
  endSession(sid: string | undefined) {
    if (sid) this.db.query('DELETE FROM sessions WHERE hash = ?').run(sha(sid))
  }

  // ---- what an account holds ------------------------------------------------------

  setNews(id: string, on: boolean) {
    this.db.query('UPDATE users SET news = ? WHERE id = ?').run(on ? 1 : 0, id)
  }
  setPlaces(id: string, input: unknown): Place[] | string {
    const p = cleanPlaces(input)
    if (typeof p === 'string') return p
    this.db.query('UPDATE users SET places = ? WHERE id = ?').run(JSON.stringify(p), id)
    return p
  }
  /** Attach a Premium key bought without an account (only one that has been paid, or is a comp key). */
  attachKey(cfg: PremiumConfig, userId: string, key: string): boolean {
    if (!KEY_SHAPE.test(key.trim())) return false
    const h = hashKey(key)
    const paid = cfg.comp.has(h) || Boolean(this.db.query('SELECT 1 FROM payments WHERE license_hash = ? AND paid_at IS NOT NULL').get(h))
    if (!paid) return false
    this.db.query('INSERT OR IGNORE INTO user_licenses (user_id, license_hash, at) VALUES (?, ?, ?)').run(userId, h, this.now())
    return true
  }
  isAdmin(u: Pick<User, 'email'> | null) {
    return Boolean(u && this.admins.has(u.email))
  }
  /** Premium on the account: an admin, a payment made while signed in, or an attached key. */
  premium(cfg: PremiumConfig, u: User | null): boolean {
    if (!u) return false
    if (this.isAdmin(u)) return true
    if (this.db.query('SELECT 1 FROM payments WHERE user_id = ? AND paid_at IS NOT NULL').get(u.id)) return true
    for (const r of this.db.query('SELECT license_hash FROM user_licenses WHERE user_id = ?').all(u.id) as Row[]) {
      if (cfg.comp.has(r.license_hash) || this.db.query('SELECT 1 FROM payments WHERE license_hash = ? AND paid_at IS NOT NULL').get(r.license_hash)) return true
    }
    return false
  }
  premiumSince(u: User): number | null {
    const r = this.db.query('SELECT MIN(paid_at) AS t FROM payments WHERE user_id = ? AND paid_at IS NOT NULL').get(u.id) as Row
    return r?.t ?? null
  }
  deleteUser(id: string) {
    this.db.transaction(() => {
      this.db.query('DELETE FROM sessions WHERE user_id = ?').run(id)
      this.db.query('DELETE FROM user_licenses WHERE user_id = ?').run(id)
      // Payments stay (they are the business's records); they just stop pointing at a person.
      this.db.query('UPDATE payments SET user_id = NULL WHERE user_id = ?').run(id)
      this.db.query('DELETE FROM users WHERE id = ?').run(id)
    })()
  }
  ban(id: string) {
    this.db.query('UPDATE users SET banned = 1 WHERE id = ?').run(id)
    this.db.query('DELETE FROM sessions WHERE user_id = ?').run(id)
  }

  /** Who asked for updates, for the newsletter (CSV, admin only). */
  newsCsv(): string {
    const rows = this.db.query('SELECT email, created_at FROM users WHERE news = 1 AND banned = 0 ORDER BY created_at').all() as Row[]
    return ['email,signed_up', ...rows.map((r) => `${r.email},${new Date(r.created_at).toISOString()}`)].join('\n') + '\n'
  }
  count(): { users: number; news: number } {
    const r = this.db.query('SELECT COUNT(*) AS users, SUM(news) AS news FROM users WHERE banned = 0').get() as Row
    return { users: r.users, news: r.news ?? 0 }
  }
}

export function mailConfig(env: Record<string, string | undefined> = process.env): MailConfig {
  return env.RESEND_API_KEY ? { apiKey: env.RESEND_API_KEY, from: env.MAIL_FROM ?? 'resident.alerts <alerts@pit.world>' } : null
}

export type Mailer = (m: { to: string; subject: string; text: string }) => Promise<boolean>

export function createMailer(cfg: MailConfig, f: typeof fetch = fetch, log: (...a: unknown[]) => void = console.log): Mailer {
  return async (m) => {
    if (!cfg) {
      log(`[mail] not configured; would send "${m.subject}" to ${m.to}`)
      return false
    }
    const r = await f('https://api.resend.com/emails', {
      method: 'POST',
      headers: { authorization: `Bearer ${cfg.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ from: cfg.from, to: [m.to], subject: m.subject, text: m.text }),
      signal: AbortSignal.timeout(15_000),
    }).catch(() => null)
    if (!r?.ok) log(`[mail] ${m.subject} failed: ${r?.status ?? 'network'}`)
    return Boolean(r?.ok)
  }
}
