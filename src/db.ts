/**
 * One SQLite file: incidents we have read, the devices that asked for push
 * alerts (and the places each one cares about), what we already sent them, how
 * each source is doing, and Premium payments through CoinPay.
 *
 * There are no accounts. A device is its push subscription: the endpoint and
 * its keys are secret to that browser, so knowing them is the proof needed to
 * change or delete its places.
 */
import { Database } from 'bun:sqlite'
import { createHash, randomBytes } from 'node:crypto'
import { inShape, km, KINDS, type Incident, type Kind } from './sources.js'

export type Place = { name: string; lat: number; lon: number; km: number }
export type Device = {
  id: string
  endpoint: string
  p256dh: string
  auth: string
  places: Place[]
  kinds: Kind[]
  min_severity: 1 | 2 | 3
  /** Incidents this device follows (a fire, mostly): it hears about every change to them. */
  follows: string[]
  created_at: number
  last_push_at: number
  fails: number
}
export type SourceState = { id: string; last_ok: number; last_error: string; last_count: number; next_at: number }
export type Payment = { ref: string; amount_cents: number; chain: string; status: string; created_at: number; license_hash: string | null; user_id: string | null }

/** CoinPay echoes our success URL, which carries the buyer's Premium key: never keep a key in a stored payload. */
export const scrubRaw = (v: unknown) => JSON.stringify(v ?? {}).replace(/ra_[A-Za-z0-9_-]{20,40}/g, 'ra_…')

export const MAX_PLACES = 25
export const MAX_FOLLOWS = 25
export const MAX_KM = 80

const deviceId = (endpoint: string) => createHash('sha256').update(endpoint).digest('hex').slice(0, 24)

export function cleanPlaces(input: unknown): Place[] | string {
  if (!Array.isArray(input)) return 'places must be a list'
  if (input.length > MAX_PLACES) return `up to ${MAX_PLACES} places`
  const out: Place[] = []
  for (const p of input as any[]) {
    const lat = Number(p?.lat)
    const lon = Number(p?.lon)
    const r = Number(p?.km ?? 2)
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return 'each place needs a lat and lon'
    if (!Number.isFinite(r) || r <= 0 || r > MAX_KM) return `radius must be between 0 and ${MAX_KM} km`
    out.push({ name: String(p?.name ?? 'Place').trim().slice(0, 40) || 'Place', lat: Math.round(lat * 1e5) / 1e5, lon: Math.round(lon * 1e5) / 1e5, km: Math.round(r * 10) / 10 })
  }
  return out
}

export const cleanKinds = (input: unknown): Kind[] => {
  const list = Array.isArray(input) ? input.filter((k): k is Kind => KINDS.includes(k as Kind)) : []
  return list.length ? [...new Set(list)] : [...KINDS]
}

type Row = Record<string, any>
const toIncident = (r: Row): Incident => ({
  id: r.id, source: r.source, kind: r.kind, severity: r.severity, title: r.title, detail: r.detail, address: r.address, area: r.area,
  lat: r.lat, lon: r.lon, at: r.at, url: r.url, ...(r.shape ? { shape: JSON.parse(r.shape) } : {}), ...(r.ended_at ? { ended_at: r.ended_at } : {}),
})
const toDevice = (r: Row): Device => ({
  id: r.id, endpoint: r.endpoint, p256dh: r.p256dh, auth: r.auth, places: JSON.parse(r.places), kinds: JSON.parse(r.kinds),
  min_severity: r.min_severity, follows: JSON.parse(r.follows ?? '[]'), created_at: r.created_at, last_push_at: r.last_push_at, fails: r.fails,
})

export class Store {
  readonly db: Database
  constructor(path = ':memory:', readonly now: () => number = Date.now) {
    this.db = new Database(path, { create: true })
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;')
    this.migrate()
  }

  private migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS incidents (
        id TEXT PRIMARY KEY, source TEXT NOT NULL, kind TEXT NOT NULL, severity INTEGER NOT NULL,
        title TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '', address TEXT NOT NULL DEFAULT '', area TEXT NOT NULL DEFAULT '',
        lat REAL NOT NULL, lon REAL NOT NULL, at INTEGER NOT NULL, url TEXT NOT NULL DEFAULT '', shape TEXT,
        seen_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS incidents_at ON incidents(at);
      CREATE INDEX IF NOT EXISTS incidents_geo ON incidents(lat, lon);
      CREATE TABLE IF NOT EXISTS devices (
        id TEXT PRIMARY KEY, endpoint TEXT NOT NULL UNIQUE, p256dh TEXT NOT NULL, auth TEXT NOT NULL,
        places TEXT NOT NULL DEFAULT '[]', kinds TEXT NOT NULL DEFAULT '[]', min_severity INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL, last_push_at INTEGER NOT NULL DEFAULT 0, fails INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS sent (
        device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE, incident_id TEXT NOT NULL, at INTEGER NOT NULL,
        PRIMARY KEY (device_id, incident_id)
      );
      CREATE INDEX IF NOT EXISTS sent_at ON sent(at);
      CREATE TABLE IF NOT EXISTS sources (
        id TEXT PRIMARY KEY, last_ok INTEGER NOT NULL DEFAULT 0, last_error TEXT NOT NULL DEFAULT '',
        last_count INTEGER NOT NULL DEFAULT 0, next_at INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS payments (
        ref TEXT PRIMARY KEY, amount_cents INTEGER NOT NULL, chain TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
        created_at INTEGER NOT NULL, raw TEXT NOT NULL DEFAULT '{}'
      );
    `)
    // 0.2.0: a payment can buy a Premium key (stored as its hash), paid_at once it settles.
    const cols = (this.db.query('PRAGMA table_info(payments)').all() as Row[]).map((c) => c.name)
    if (!cols.includes('license_hash')) this.db.exec('ALTER TABLE payments ADD COLUMN license_hash TEXT')
    if (!cols.includes('paid_at')) this.db.exec('ALTER TABLE payments ADD COLUMN paid_at INTEGER')
    // 0.4.0: Premium bought while signed in belongs to the account.
    if (!cols.includes('user_id')) this.db.exec('ALTER TABLE payments ADD COLUMN user_id TEXT')
    this.db.exec('CREATE INDEX IF NOT EXISTS payments_license ON payments(license_hash)')
    // 0.6.0: live sources (fires, evacuation zones, standing warnings) stay on the map until they end; devices follow fires.
    const icols = (this.db.query('PRAGMA table_info(incidents)').all() as Row[]).map((c) => c.name)
    if (!icols.includes('live')) this.db.exec('ALTER TABLE incidents ADD COLUMN live INTEGER NOT NULL DEFAULT 0')
    if (!icols.includes('ended_at')) this.db.exec('ALTER TABLE incidents ADD COLUMN ended_at INTEGER')
    this.db.exec('CREATE INDEX IF NOT EXISTS incidents_live ON incidents(source) WHERE live = 1 AND ended_at IS NULL')
    const dcols = (this.db.query('PRAGMA table_info(devices)').all() as Row[]).map((c) => c.name)
    if (!dcols.includes('follows')) this.db.exec("ALTER TABLE devices ADD COLUMN follows TEXT NOT NULL DEFAULT '[]'")
  }

  // ---- incidents ------------------------------------------------------------

  /** Insert or refresh a batch; returns the ones we had never seen. */
  upsertIncidents(list: Incident[]): Incident[] {
    return this.sync(list).fresh
  }

  /**
   * Insert or refresh a batch. `fresh` were never seen; `changed` were, and now
   * say something different (a fire grew, or got more contained). With `live`,
   * the batch is the source's whole current list: whatever of that source it
   * leaves out has `ended`.
   */
  sync(list: Incident[], opts: { live?: string } = {}): { fresh: Incident[]; changed: Incident[]; ended: Incident[] } {
    const now = this.now()
    const before = this.db.query('SELECT title, detail, severity, ended_at FROM incidents WHERE id = ?')
    const insert = this.db.query(
      'INSERT INTO incidents (id, source, kind, severity, title, detail, address, area, lat, lon, at, url, shape, seen_at, updated_at, live) VALUES ($id, $source, $kind, $severity, $title, $detail, $address, $area, $lat, $lon, $at, $url, $shape, $now, $now, $live) ON CONFLICT(id) DO UPDATE SET kind = $kind, severity = $severity, title = $title, detail = $detail, address = $address, lat = $lat, lon = $lon, url = $url, shape = $shape, updated_at = $now, live = $live, ended_at = NULL',
    )
    const fresh: Incident[] = []
    const changed: Incident[] = []
    let ended: Incident[] = []
    this.db.transaction(() => {
      for (const i of list) {
        const b = before.get(i.id) as Row | null
        if (!b) fresh.push(i)
        else if (b.ended_at === null && (b.title !== i.title || b.detail !== i.detail || b.severity !== i.severity)) changed.push(i)
        insert.run({ $id: i.id, $source: i.source, $kind: i.kind, $severity: i.severity, $title: i.title, $detail: i.detail, $address: i.address, $area: i.area, $lat: i.lat, $lon: i.lon, $at: i.at, $url: i.url, $shape: i.shape ? JSON.stringify(i.shape) : null, $now: now, $live: opts.live ? 1 : 0 })
      }
      if (opts.live) {
        const open = (this.db.query('SELECT * FROM incidents WHERE source = ? AND live = 1 AND ended_at IS NULL').all(opts.live) as Row[]).map(toIncident)
        const keep = new Set(list.map((i) => i.id))
        // An empty answer from a feed that had plenty is an outage, not every fire going out at once.
        if (list.length || open.length <= 20) {
          ended = open.filter((i) => !keep.has(i.id))
          const end = this.db.query('UPDATE incidents SET ended_at = ? WHERE id = ?')
          for (const i of ended) end.run(now, i.id)
        }
      }
    })()
    return { fresh, changed, ended }
  }

  incident(id: string): Incident | null {
    const r = this.db.query('SELECT * FROM incidents WHERE id = ?').get(id) as Row | null
    return r ? toIncident(r) : null
  }

  /** Incidents near a point (or anywhere), newest first. NWS polygons count if the point is inside them. */
  near(o: { lat?: number; lon?: number; km?: number; sinceMs?: number; kinds?: Kind[]; minSeverity?: number; limit?: number; source?: string }): (Incident & { distance_km: number | null })[] {
    const since = o.sinceMs ?? this.now() - 24 * 3600_000
    const limit = Math.min(Math.max(o.limit ?? 200, 1), 1000)
    const kinds = o.kinds?.length ? o.kinds : KINDS
    const marks = kinds.map(() => '?').join(',')
    const args: (string | number)[] = [since, ...kinds, o.minSeverity ?? 1]
    // Ongoing incidents from live sources (an active fire, an evacuation order) show however long ago they began.
    let sql = `SELECT * FROM incidents WHERE (at >= ? OR live = 1) AND ended_at IS NULL AND kind IN (${marks}) AND severity >= ?`
    if (o.source) {
      sql += ' AND source = ?'
      args.push(o.source)
    }
    const hasPoint = Number.isFinite(o.lat) && Number.isFinite(o.lon)
    const radius = Math.min(o.km ?? 10, 500)
    if (hasPoint) {
      // A box first (cheap, indexed), then the true distance. NWS areas are big, so they skip the box.
      const dLat = radius / 111
      const dLon = radius / (111 * Math.max(0.1, Math.cos((o.lat! * Math.PI) / 180)))
      sql += ' AND ((lat BETWEEN ? AND ? AND lon BETWEEN ? AND ?) OR shape IS NOT NULL)'
      args.push(o.lat! - dLat, o.lat! + dLat, o.lon! - dLon, o.lon! + dLon)
    }
    sql += ' ORDER BY at DESC LIMIT ?'
    args.push(hasPoint ? 5000 : limit)
    const rows = (this.db.query(sql).all(...args) as Row[]).map(toIncident)
    if (!hasPoint) return rows.map((i) => ({ ...i, distance_km: null }))
    const out: (Incident & { distance_km: number | null })[] = []
    for (const i of rows) {
      const d = km(o.lat!, o.lon!, i.lat, i.lon)
      if (i.shape ? inShape(o.lat!, o.lon!, i.shape) || d <= radius : d <= radius) out.push({ ...i, distance_km: Math.round(d * 100) / 100 })
      if (out.length >= limit) break
    }
    return out
  }

  counts(sinceMs: number): { source: string; kind: string; n: number }[] {
    return this.db.query('SELECT source, kind, COUNT(*) AS n FROM incidents WHERE at >= ? GROUP BY source, kind').all(sinceMs) as any
  }

  /** History is kept for `days`; older incidents and sent rows go. */
  prune(days = 30): number {
    const cut = this.now() - days * 86_400_000
    this.db.query('DELETE FROM sent WHERE at < ?').run(cut)
    return this.db.query('DELETE FROM incidents WHERE at < ? AND NOT (live = 1 AND ended_at IS NULL)').run(cut).changes
  }

  // ---- devices ------------------------------------------------------------

  saveDevice(sub: { endpoint: string; p256dh: string; auth: string }, prefs: { places: Place[]; kinds: Kind[]; min_severity: number }): Device {
    const id = deviceId(sub.endpoint)
    const sev = [1, 2, 3].includes(prefs.min_severity) ? prefs.min_severity : 1
    this.db
      .query(
        'INSERT INTO devices (id, endpoint, p256dh, auth, places, kinds, min_severity, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(endpoint) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth, places = excluded.places, kinds = excluded.kinds, min_severity = excluded.min_severity, fails = 0',
      )
      .run(id, sub.endpoint, sub.p256dh, sub.auth, JSON.stringify(prefs.places), JSON.stringify(prefs.kinds), sev, this.now())
    return this.device(sub.endpoint)!
  }

  device(endpoint: string): Device | null {
    const r = this.db.query('SELECT * FROM devices WHERE endpoint = ?').get(endpoint) as Row | null
    return r ? toDevice(r) : null
  }

  /** The device, only if the caller also knows its auth secret. */
  deviceFor(endpoint: string, auth: string): Device | null {
    const d = this.device(endpoint)
    return d && d.auth === auth ? d : null
  }

  deleteDevice(endpoint: string): boolean {
    return this.db.query('DELETE FROM devices WHERE endpoint = ?').run(endpoint).changes > 0
  }

  devices(): Device[] {
    return (this.db.query('SELECT * FROM devices').all() as Row[]).map(toDevice)
  }

  /** Follow or unfollow an incident; returns the device's follows. */
  follow(deviceId: string, incidentId: string, on: boolean): string[] | string {
    const r = this.db.query('SELECT follows FROM devices WHERE id = ?').get(deviceId) as Row | null
    if (!r) return 'no such device'
    const list: string[] = JSON.parse(r.follows ?? '[]').filter((id: string) => id !== incidentId)
    if (on) {
      if (list.length >= MAX_FOLLOWS) return `you can follow up to ${MAX_FOLLOWS} at once`
      list.push(incidentId)
    }
    this.db.query('UPDATE devices SET follows = ? WHERE id = ?').run(JSON.stringify(list), deviceId)
    return list
  }

  countDevices(): number {
    return (this.db.query('SELECT COUNT(*) AS n FROM devices').get() as Row).n
  }

  /** Mark sent; false if this device already got this incident. */
  markSent(deviceId: string, incidentId: string): boolean {
    return this.db.query('INSERT OR IGNORE INTO sent (device_id, incident_id, at) VALUES (?, ?, ?)').run(deviceId, incidentId, this.now()).changes > 0
  }

  sentSince(deviceId: string, sinceMs: number): number {
    return (this.db.query('SELECT COUNT(*) AS n FROM sent WHERE device_id = ? AND at >= ?').get(deviceId, sinceMs) as Row).n
  }

  pushed(deviceId: string, ok: boolean) {
    if (ok) this.db.query('UPDATE devices SET last_push_at = ?, fails = 0 WHERE id = ?').run(this.now(), deviceId)
    else this.db.query('UPDATE devices SET fails = fails + 1 WHERE id = ?').run(deviceId)
  }

  // ---- sources ------------------------------------------------------------

  sourceState(id: string): SourceState {
    return (this.db.query('SELECT * FROM sources WHERE id = ?').get(id) as SourceState | null) ?? { id, last_ok: 0, last_error: '', last_count: 0, next_at: 0 }
  }

  sourceStates(): SourceState[] {
    return this.db.query('SELECT * FROM sources').all() as SourceState[]
  }

  recordRead(id: string, r: { ok: boolean; count?: number; error?: string; nextAt: number }) {
    const s = this.sourceState(id)
    this.db
      .query('INSERT INTO sources (id, last_ok, last_error, last_count, next_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET last_ok = excluded.last_ok, last_error = excluded.last_error, last_count = excluded.last_count, next_at = excluded.next_at')
      .run(id, r.ok ? this.now() : s.last_ok, r.ok ? '' : String(r.error ?? 'failed').slice(0, 300), r.ok ? (r.count ?? 0) : s.last_count, r.nextAt)
  }

  // ---- Premium ------------------------------------------------------------

  recordPayment(p: { ref: string; amount_cents: number; chain: string; raw: unknown; license_hash?: string; user_id?: string }) {
    this.db.query('INSERT OR IGNORE INTO payments (ref, amount_cents, chain, created_at, raw, license_hash, user_id) VALUES (?, ?, ?, ?, ?, ?, ?)').run(p.ref, p.amount_cents, p.chain, this.now(), scrubRaw(p.raw), p.license_hash ?? null, p.user_id ?? null)
  }

  payment(ref: string): Payment | null {
    return (this.db.query('SELECT ref, amount_cents, chain, status, created_at, license_hash, user_id FROM payments WHERE ref = ?').get(ref) as Payment | null) ?? null
  }

  /** Record the webhook's status; a settled one stamps paid_at (once, and it never un-pays). */
  settlePayment(ref: string, status: string, raw: unknown, settled: boolean) {
    this.db.query('UPDATE payments SET status = ?, raw = ?, paid_at = CASE WHEN ? AND paid_at IS NULL THEN ? ELSE paid_at END WHERE ref = ?').run(status, scrubRaw(raw), settled ? 1 : 0, this.now(), ref)
  }

  licensePaid(hash: string): boolean {
    return Boolean(this.db.query('SELECT 1 FROM payments WHERE license_hash = ? AND paid_at IS NOT NULL').get(hash))
  }

  /** The Premium payment behind a key: 'paid', 'pending' or null if we never sold it. */
  licenseState(hash: string): 'paid' | 'pending' | null {
    const r = this.db.query('SELECT MAX(paid_at IS NOT NULL) AS paid FROM payments WHERE license_hash = ?').get(hash) as Row | null
    return r?.paid === null || r?.paid === undefined ? null : r.paid ? 'paid' : 'pending'
  }

  premiumCount(): number {
    return (this.db.query('SELECT COUNT(DISTINCT license_hash) AS n FROM payments WHERE paid_at IS NOT NULL').get() as Row).n
  }
}

export const newSecret = () => randomBytes(24).toString('base64url')
