/**
 * Customer webhooks (@profullstack/webhooks): an account's own server hears
 * what its push alerts say, as signed CloudEvents.
 *
 * Who gets what: an event belongs to the account it is about. Alerts are about
 * the places an account saved (Alerts on the map, synced to the account), so an
 * account's endpoints hear about incidents in its own places, and about its own
 * Premium. Devices stay anonymous (a push subscription with no account), so
 * they are not webhook owners.
 *
 * What a receiver sees about an incident is what the public map shows: the
 * agency's call, or a resident report's text once neighbors confirmed it. Never
 * who reported it, their pseudonym, media, or any other account's places.
 */
import type { Database } from 'bun:sqlite'
import { sqliteStore, Webhooks, type GuardOptions } from '@profullstack/webhooks'
import type { Place } from './db.js'
import { KINDS, type Incident } from './sources.js'
import { FRESH_MS, followDigest, matchPlace } from './worker.js'

export const WEBHOOK_EVENTS = ['alert.issued', 'alert.updated', 'alert.ended', 'premium.activated']
/** A busy city at 50 miles is a lot of calls; past this an account's endpoints wait for the next hour. */
export const ACCOUNT_HOURLY = 200

export function createHooks(db: Database, o: { source: string; fetch?: typeof fetch; guard?: GuardOptions; log?: (m: string) => void }): Webhooks {
  return new Webhooks({
    store: sqliteStore(db as never),
    source: o.source,
    eventTypes: WEBHOOK_EVENTS,
    ...(o.fetch ? { fetchImpl: o.fetch } : {}),
    ...(o.guard ? { guard: o.guard } : {}),
    log: o.log ?? ((m: string) => console.log(`[webhooks] ${m}`)),
  })
}

const iso = (ms: number) => new Date(ms).toISOString()

/** The public record of an incident, plus which of the owner's places it concerns. */
export function incidentData(i: Incident, origin: string, place?: { name: string; km: number }) {
  return {
    incident: {
      id: i.id,
      source: i.source,
      kind: i.kind,
      severity: i.severity,
      title: i.title,
      detail: i.detail,
      address: i.address,
      area: i.area,
      lat: i.lat,
      lon: i.lon,
      at: iso(i.at),
      ...(i.ended_at ? { ended_at: iso(i.ended_at) } : {}),
      area_outline: Boolean(i.shape),
      page: `${origin}/i/${encodeURIComponent(i.id)}`,
      api: `${origin}/api/v1/incidents/${encodeURIComponent(i.id)}`,
    },
    ...(place ? { place: { name: place.name, distance_km: Math.round(place.km * 100) / 100 } } : {}),
  }
}

type Row = Record<string, any>

/** Account alerts: the worker hands it what changed; it emits to the accounts each change is about. */
export class AccountAlerts {
  constructor(
    readonly db: Database,
    readonly hooks: Webhooks,
    readonly origin: string,
    readonly now: () => number = Date.now,
  ) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS account_sent (user_id TEXT NOT NULL, key TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (user_id, key));
      CREATE INDEX IF NOT EXISTS account_sent_at ON account_sent(at);
    `)
  }

  /** Accounts with a working webhook and at least one saved place. */
  watchers(): { id: string; places: Place[] }[] {
    const has = (t: string) => Boolean(this.db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t))
    if (!has('users') || !has('webhook_endpoints')) return []
    const rows = this.db
      .query("SELECT u.id, u.places FROM users u WHERE u.banned = 0 AND u.places != '[]' AND EXISTS (SELECT 1 FROM webhook_endpoints e WHERE e.owner = u.id AND e.enabled = 1)")
      .all() as Row[]
    return rows.map((r) => ({ id: r.id, places: JSON.parse(r.places || '[]') as Place[] })).filter((w) => w.places.length)
  }
  private mark(userId: string, key: string): boolean {
    return this.db.query('INSERT OR IGNORE INTO account_sent (user_id, key, at) VALUES (?, ?, ?)').run(userId, key, this.now()).changes > 0
  }
  private had(userId: string, incidentId: string): boolean {
    return Boolean(this.db.query('SELECT 1 FROM account_sent WHERE user_id = ? AND key = ?').get(userId, incidentId))
  }
  private budget(userId: string): number {
    return ACCOUNT_HOURLY - (this.db.query('SELECT COUNT(*) AS n FROM account_sent WHERE user_id = ? AND at >= ?').get(userId, this.now() - 3600_000) as Row).n
  }

  /**
   * New incidents in an account's places: `alert.issued`, once per incident.
   * `anyAge` is a fire that grew: old, but its edge only now reaches a place.
   */
  async issued(list: Incident[], anyAge = false): Promise<number> {
    const now = this.now()
    const recent = anyAge ? list : list.filter((i) => now - i.at <= FRESH_MS && i.at <= now + 5 * 60_000)
    if (!recent.length) return 0
    let n = 0
    for (const w of this.watchers()) {
      let budget = this.budget(w.id)
      for (const i of [...recent].sort((a, b) => b.severity - a.severity || b.at - a.at)) {
        if (budget <= 0) break
        const place = matchPlace({ places: w.places, kinds: [...KINDS], min_severity: 1 }, i)
        if (!place || !this.mark(w.id, i.id)) continue
        budget -= 1
        await this.hooks.emit(w.id, 'alert.issued', incidentData(i, this.origin, place), { subject: `incident:${i.id}` })
        n += 1
      }
    }
    return n
  }

  /** Incidents an account was alerted about that changed (`alert.updated`) or ended (`alert.ended`). */
  async changed(changed: Incident[], ended: Incident[]): Promise<number> {
    const events = [...changed.map((i) => ({ i, ended: false })), ...ended.map((i) => ({ i, ended: true }))]
    if (!events.length) return 0
    let n = 0
    for (const w of this.watchers()) {
      for (const e of events) {
        // Only what this account already heard about, and the same numbers never twice.
        if (!this.had(w.id, e.i.id) || !this.mark(w.id, `${e.i.id}#${followDigest(e.i, e.ended)}`)) continue
        await this.hooks.emit(w.id, e.ended ? 'alert.ended' : 'alert.updated', incidentData(e.i, this.origin), { subject: `incident:${e.i.id}` })
        n += 1
      }
    }
    return n
  }

  /** Premium switched on for an account (a payment settled, or a credit code). */
  async premium(userId: string, via: 'payment' | 'credit-code', extra: Record<string, unknown> = {}): Promise<void> {
    await this.hooks.emit(userId, 'premium.activated', { via, lifetime: true, ...extra, at: iso(this.now()) }, { subject: `account:${userId}` })
  }

  prune(days = 30): number {
    return this.db.query('DELETE FROM account_sent WHERE at < ?').run(this.now() - days * 86_400_000).changes
  }
}
