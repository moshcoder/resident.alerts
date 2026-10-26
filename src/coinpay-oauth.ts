/**
 * Sign in with CoinPay: OAuth 2.1 authorization code + PKCE (S256), the way
 * every fleet app signs in against the CoinPay hub.
 *
 * The state and the PKCE verifier live in our database for ten minutes and are
 * spent on the first callback, so a callback cannot be replayed or forged from
 * another browser. We only ever trust what CoinPay's userinfo endpoint says,
 * fetched with the access token we just got ourselves.
 */
import type { Database } from 'bun:sqlite'
import { createHash, randomBytes } from 'node:crypto'

export type OAuthConfig = { clientId: string; clientSecret: string; base: string } | null
export type CoinPayProfile = { sub: string; email: string | null; name: string | null }

export const STATE_MS = 10 * 60_000
const b64url = (b: Buffer) => b.toString('base64url')

export function oauthConfig(env: Record<string, string | undefined> = process.env): OAuthConfig {
  if (!env.COINPAY_OAUTH_CLIENT_ID || !env.COINPAY_OAUTH_CLIENT_SECRET) return null
  return { clientId: env.COINPAY_OAUTH_CLIENT_ID, clientSecret: env.COINPAY_OAUTH_CLIENT_SECRET, base: (env.COINPAY_OAUTH_URL ?? 'https://coinpayportal.com').replace(/\/+$/, '') }
}

export class CoinPayOAuth {
  constructor(readonly db: Database, readonly cfg: NonNullable<OAuthConfig>, private readonly f: typeof fetch = fetch, readonly now: () => number = Date.now) {
    db.exec('CREATE TABLE IF NOT EXISTS oauth_states (state TEXT PRIMARY KEY, verifier TEXT NOT NULL, redirect_uri TEXT NOT NULL, next TEXT NOT NULL, link_user TEXT, news INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL)')
  }

  /** Where to send the browser. `linkUser` is set when a signed-in account is connecting CoinPay. */
  start(o: { redirectUri: string; next: string; linkUser?: string | null; news?: boolean }): string {
    const state = b64url(randomBytes(24))
    const verifier = b64url(randomBytes(48))
    const challenge = b64url(createHash('sha256').update(verifier).digest())
    this.db.query('DELETE FROM oauth_states WHERE created_at < ?').run(this.now() - STATE_MS)
    this.db.query('INSERT INTO oauth_states (state, verifier, redirect_uri, next, link_user, news, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(state, verifier, o.redirectUri, o.next, o.linkUser ?? null, o.news ? 1 : 0, this.now())
    const q = new URLSearchParams({ response_type: 'code', client_id: this.cfg.clientId, redirect_uri: o.redirectUri, scope: 'openid profile email', state, code_challenge: challenge, code_challenge_method: 'S256' })
    return `${this.cfg.base}/api/oauth/authorize?${q}`
  }

  /** Spend the state; null if unknown, old, or already used. */
  private take(state: string) {
    const r = this.db.query('SELECT * FROM oauth_states WHERE state = ?').get(state) as Record<string, any> | null
    if (!r) return null
    this.db.query('DELETE FROM oauth_states WHERE state = ?').run(state)
    return this.now() - r.created_at > STATE_MS ? null : { verifier: r.verifier as string, redirectUri: r.redirect_uri as string, next: r.next as string, linkUser: (r.link_user as string | null) ?? null, news: Boolean(r.news) }
  }

  /** The callback: code -> tokens -> who this is. */
  async finish(code: string, state: string): Promise<({ profile: CoinPayProfile } & NonNullable<ReturnType<CoinPayOAuth['take']>>) | { error: string }> {
    const s = this.take(state)
    if (!s) return { error: 'That sign-in took too long or was already used. Try again.' }
    const tokenRes = await this.f(`${this.cfg.base}/api/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: s.redirectUri, client_id: this.cfg.clientId, client_secret: this.cfg.clientSecret, code_verifier: s.verifier }).toString(),
      signal: AbortSignal.timeout(15_000),
    }).catch(() => null)
    const tok = tokenRes?.ok ? ((await tokenRes.json().catch(() => null)) as { access_token?: string } | null) : null
    if (!tok?.access_token) return { error: 'CoinPay did not accept the sign-in. Try again.' }
    const infoRes = await this.f(`${this.cfg.base}/api/oauth/userinfo`, { headers: { authorization: `Bearer ${tok.access_token}`, accept: 'application/json' }, signal: AbortSignal.timeout(15_000) }).catch(() => null)
    const info = infoRes?.ok ? ((await infoRes.json().catch(() => null)) as Record<string, unknown> | null) : null
    const sub = typeof info?.sub === 'string' && info.sub ? info.sub : null
    if (!sub) return { error: 'CoinPay did not say who you are. Try again.' }
    const email = typeof info?.email === 'string' && /@/.test(info.email) ? info.email.toLowerCase() : null
    const name = typeof info?.name === 'string' ? info.name : typeof info?.preferred_username === 'string' ? (info.preferred_username as string) : null
    return { ...s, profile: { sub, email, name } }
  }
}
