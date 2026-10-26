/**
 * The community: comments on incidents, a chat for each area, residents'
 * own reports, and the photos and videos people attach to them.
 *
 * Identity is a pseudonym: a resident is a random token (rt_…) the browser
 * keeps, plus a display name. No email, no phone. That keeps it as anonymous as
 * the rest of the app, so the guard rails are rate limits, three-flag hiding,
 * and an admin key that can remove anything and ban a resident (and the network
 * they posted from).
 *
 * Media: photos arrive already re-encoded by the browser (which drops EXIF and
 * its GPS); MP4/MOV videos get their metadata boxes blanked here so a phone's
 * location tag never goes public. Everything is capped in size, per day, and in
 * total disk (oldest removed first).
 */
import type { Database } from 'bun:sqlite'
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { mkdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { Store } from './db.js'
import { KINDS, type Incident, type Kind } from './sources.js'

export type Resident = { id: string; name: string; created_at: number; banned: number }
export type Media = { id: string; resident_id: string; kind: 'photo' | 'video'; mime: string; bytes: number; created_at: number }
export type Post = { id: string; room: string; resident_id: string; name: string; text: string; media: { id: string; kind: string; url: string }[]; created_at: number; mine?: boolean }

export const PHOTO_MAX = 10 * 1024 * 1024
export const VIDEO_MAX = 25 * 1024 * 1024
export const TEXT_MAX = 1000
export const FLAGS_TO_HIDE = 3
export const CONFIRMS_TO_ALERT = 2

const sha = (s: string) => createHash('sha256').update(s).digest('hex')
const newId = (n = 9) => randomBytes(n).toString('base64url')

// ---- geohash (area chat cells) -------------------------------------------------
const B32 = '0123456789bcdefghjkmnpqrstuvwxyz'
export function geohash(lat: number, lon: number, precision = 4): string {
  let [la0, la1, lo0, lo1] = [-90, 90, -180, 180]
  let out = ''
  let bit = 0
  let ch = 0
  let even = true
  while (out.length < precision) {
    if (even) {
      const mid = (lo0 + lo1) / 2
      if (lon >= mid) (ch |= 16 >> bit), (lo0 = mid)
      else lo1 = mid
    } else {
      const mid = (la0 + la1) / 2
      if (lat >= mid) (ch |= 16 >> bit), (la0 = mid)
      else la1 = mid
    }
    even = !even
    if (bit < 4) bit++
    else (out += B32[ch]), (bit = 0), (ch = 0)
  }
  return out
}
export const AREA_ROOM = /^a:[0-9b-hjkmnp-z]{4}$/
export const areaRoom = (lat: number, lon: number) => `a:${geohash(lat, lon, 4)}`

// ---- text + media checks -----------------------------------------------------------

/** Trimmed, control characters out, at most two blank lines in a row and two links. */
export function cleanText(input: unknown): string | { error: string } {
  const t = String(input ?? '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f‪-‮⁦-⁩]/g, '')
    .replace(/\r\n?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  if (t.length > TEXT_MAX) return { error: `Keep it under ${TEXT_MAX} characters.` }
  if ((t.match(/https?:\/\//gi) ?? []).length > 2) return { error: 'Two links at most.' }
  return t
}

export function cleanName(input: unknown): string | null {
  const n = String(input ?? '').replace(/\s+/g, ' ').trim()
  return /^[\p{L}\p{N} ._'-]{2,30}$/u.test(n) && !/admin|moderator|police|official|911|sheriff/i.test(n) ? n : null
}

/** What a file really is, from its first bytes. */
export function sniff(b: Uint8Array): { kind: 'photo' | 'video'; mime: string; ext: string } | null {
  const s = (i: number, n: number) => String.fromCharCode(...b.slice(i, i + n))
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { kind: 'photo', mime: 'image/jpeg', ext: 'jpg' }
  if (b[0] === 0x89 && s(1, 3) === 'PNG') return { kind: 'photo', mime: 'image/png', ext: 'png' }
  if (s(0, 4) === 'RIFF' && s(8, 4) === 'WEBP') return { kind: 'photo', mime: 'image/webp', ext: 'webp' }
  if (s(0, 4) === 'GIF8') return { kind: 'photo', mime: 'image/gif', ext: 'gif' }
  if (s(4, 4) === 'ftyp') {
    const brand = s(8, 4)
    if (/^(heic|heix|mif1|msf1|avif)$/.test(brand)) return null // stills the browser could not re-encode
    return /^qt/.test(brand) ? { kind: 'video', mime: 'video/quicktime', ext: 'mov' } : { kind: 'video', mime: 'video/mp4', ext: 'mp4' }
  }
  if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return { kind: 'video', mime: 'video/webm', ext: 'webm' }
  return null
}

/**
 * Blank every `udta` and `meta` box in an MP4/MOV (where phones keep the
 * location, the device and the owner name) by renaming it `free` and zeroing
 * it. Sizes and offsets stay the same, so the video plays exactly as before.
 */
export function scrubMp4(buf: Uint8Array): number {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  let blanked = 0
  const walk = (start: number, end: number, depth: number) => {
    let p = start
    while (p + 8 <= end) {
      let size = dv.getUint32(p)
      const type = String.fromCharCode(buf[p + 4]!, buf[p + 5]!, buf[p + 6]!, buf[p + 7]!)
      let header = 8
      if (size === 1 && p + 16 <= end) (size = Number(dv.getBigUint64(p + 8))), (header = 16)
      else if (size === 0) size = end - p
      if (size < header || p + size > end) return
      if (type === 'udta' || (type === 'meta' && depth > 0)) {
        buf.set([0x66, 0x72, 0x65, 0x65], p + 4) // 'free'
        buf.fill(0, p + header, p + size)
        blanked += 1
      } else if (['moov', 'trak', 'mdia', 'minf', 'stbl'].includes(type)) walk(p + header, p + size, depth + 1)
      p += size
    }
  }
  walk(0, buf.length, 0)
  return blanked
}

// ---- the store -------------------------------------------------------------------

type Row = Record<string, any>

export class Community {
  readonly mediaDir: string
  constructor(readonly db: Database, readonly store: Store, dir: string, readonly opts: { maxBytes?: number; adminKey?: string; secret?: string } = {}) {
    this.mediaDir = dir
    mkdirSync(dir, { recursive: true })
    db.exec(`
      CREATE TABLE IF NOT EXISTS residents (id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, name TEXT NOT NULL, ip_hash TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL, banned INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS banned_networks (ip_hash TEXT PRIMARY KEY, at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS media (id TEXT PRIMARY KEY, resident_id TEXT NOT NULL, kind TEXT NOT NULL, mime TEXT NOT NULL, ext TEXT NOT NULL, bytes INTEGER NOT NULL, created_at INTEGER NOT NULL, hidden INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS posts (id TEXT PRIMARY KEY, room TEXT NOT NULL, resident_id TEXT NOT NULL, text TEXT NOT NULL, media TEXT NOT NULL DEFAULT '[]', created_at INTEGER NOT NULL, hidden INTEGER NOT NULL DEFAULT 0);
      CREATE INDEX IF NOT EXISTS posts_room ON posts(room, created_at);
      CREATE TABLE IF NOT EXISTS reports (id TEXT PRIMARY KEY, resident_id TEXT NOT NULL, media TEXT NOT NULL DEFAULT '[]', created_at INTEGER NOT NULL, alerted INTEGER NOT NULL DEFAULT 0, hidden INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS confirms (report_id TEXT NOT NULL, resident_id TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (report_id, resident_id));
      CREATE TABLE IF NOT EXISTS flags (target TEXT NOT NULL, resident_id TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (target, resident_id));
      CREATE TABLE IF NOT EXISTS resident_tokens (hash TEXT PRIMARY KEY, resident_id TEXT NOT NULL, at INTEGER NOT NULL);
    `)
    // 0.4.0: a resident belongs to an account; each signed-in browser gets its own token.
    const cols = (db.query('PRAGMA table_info(residents)').all() as Row[]).map((c) => c.name)
    if (!cols.includes('user_id')) db.exec('ALTER TABLE residents ADD COLUMN user_id TEXT')
    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS residents_user ON residents(user_id) WHERE user_id IS NOT NULL')
  }

  now() {
    return this.store.now()
  }
  ipHash(ip: string) {
    // Keyed, so the table never holds anything that maps back to an address on its own.
    return createHmac('sha256', this.opts.secret ?? 'resident.alerts').update(ip).digest('hex').slice(0, 24)
  }

  // ---- residents ---------------------------------------------------------------

  networkBanned(ip: string) {
    return Boolean(this.db.query('SELECT 1 FROM banned_networks WHERE ip_hash = ?').get(this.ipHash(ip)))
  }
  residentsFrom(ip: string, sinceMs: number): number {
    return (this.db.query('SELECT COUNT(*) AS n FROM residents WHERE ip_hash = ? AND created_at >= ?').get(this.ipHash(ip), sinceMs) as Row).n
  }
  newResident(name: string | null, ip: string): { resident: Resident; token: string } {
    const id = newId(6)
    const token = `rt_${newId(24)}`
    const n = name ?? `Neighbor ${String(Math.floor(1000 + Math.random() * 9000))}`
    this.db.query('INSERT INTO residents (id, token_hash, name, ip_hash, created_at) VALUES (?, ?, ?, ?, ?)').run(id, sha(token), n, this.ipHash(ip), this.now())
    return { resident: this.resident(id)!, token }
  }
  resident(id: string): Resident | null {
    return (this.db.query('SELECT id, name, created_at, banned FROM residents WHERE id = ?').get(id) as Resident | null) ?? null
  }
  byToken(token: string | undefined): Resident | null {
    if (!token || !/^rt_[A-Za-z0-9_-]{20,}$/.test(token)) return null
    const h = sha(token)
    const r = (this.db.query('SELECT id, name, created_at, banned FROM residents WHERE token_hash = ?').get(h) ??
      this.db.query('SELECT r.id, r.name, r.created_at, r.banned FROM resident_tokens t JOIN residents r ON r.id = t.resident_id WHERE t.hash = ?').get(h)) as Resident | null
    return r && !r.banned ? r : null
  }
  /** The account's community name (made on first use) and a fresh token for this browser. */
  residentForUser(userId: string, name: string | null, ip: string): { resident: Resident; token: string } {
    const existing = this.db.query('SELECT id FROM residents WHERE user_id = ?').get(userId) as Row | null
    if (!existing) {
      const made = this.newResident(name, ip)
      this.db.query('UPDATE residents SET user_id = ? WHERE id = ?').run(userId, made.resident.id)
      return made
    }
    if (name) this.rename(existing.id, name)
    const token = `rt_${newId(24)}`
    this.db.query('INSERT INTO resident_tokens (hash, resident_id, at) VALUES (?, ?, ?)').run(sha(token), existing.id, this.now())
    return { resident: this.resident(existing.id)!, token }
  }
  userOf(residentId: string): string | null {
    return ((this.db.query('SELECT user_id FROM residents WHERE id = ?').get(residentId) as Row | null)?.user_id as string | null) ?? null
  }
  rename(id: string, name: string) {
    this.db.query('UPDATE residents SET name = ? WHERE id = ?').run(name, id)
  }
  ban(id: string) {
    const r = this.db.query('SELECT ip_hash FROM residents WHERE id = ?').get(id) as Row | null
    if (!r) return false
    this.db.transaction(() => {
      this.db.query('UPDATE residents SET banned = 1 WHERE id = ?').run(id)
      if (r.ip_hash) this.db.query('INSERT OR IGNORE INTO banned_networks (ip_hash, at) VALUES (?, ?)').run(r.ip_hash, this.now())
      this.db.query('UPDATE posts SET hidden = 1 WHERE resident_id = ?').run(id)
      this.db.query('UPDATE media SET hidden = 1 WHERE resident_id = ?').run(id)
      this.db.query('UPDATE reports SET hidden = 1 WHERE resident_id = ?').run(id)
    })()
    for (const rep of this.db.query('SELECT id FROM reports WHERE resident_id = ?').all(id) as Row[]) this.store.db.query('DELETE FROM incidents WHERE id = ?').run(rep.id)
    return true
  }
  isAdmin(key: string | undefined) {
    const k = this.opts.adminKey
    if (!k || !key) return false
    const a = Buffer.from(sha(k))
    const b = Buffer.from(sha(key))
    return timingSafeEqual(a, b)
  }

  // ---- media ----------------------------------------------------------------

  countSince(table: 'posts' | 'media' | 'reports', residentId: string, sinceMs: number): number {
    const sql = { posts: 'SELECT COUNT(*) AS n FROM posts WHERE resident_id = ? AND created_at >= ?', media: 'SELECT COUNT(*) AS n FROM media WHERE resident_id = ? AND created_at >= ?', reports: 'SELECT COUNT(*) AS n FROM reports WHERE resident_id = ? AND created_at >= ?' }[table]
    return (this.db.query(sql).get(residentId, sinceMs) as Row).n
  }

  /** Store an upload. Returns the media row or why not. */
  async addMedia(residentId: string, bytes: Uint8Array): Promise<Media | { error: string }> {
    const t = sniff(bytes)
    if (!t) return { error: 'Photos (JPEG, PNG, WebP, GIF) or videos (MP4, MOV, WebM) only.' }
    if (t.kind === 'photo' && bytes.length > PHOTO_MAX) return { error: 'Photos up to 10 MB.' }
    if (t.kind === 'video' && bytes.length > VIDEO_MAX) return { error: 'Videos up to 25 MB (about 30 seconds).' }
    if (t.ext === 'mp4' || t.ext === 'mov') scrubMp4(bytes)
    const id = newId(12)
    await Bun.write(join(this.mediaDir, `${id}.${t.ext}`), bytes)
    this.db.query('INSERT INTO media (id, resident_id, kind, mime, ext, bytes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(id, residentId, t.kind, t.mime, t.ext, bytes.length, this.now())
    this.enforceDiskCap()
    return this.media(id)!
  }
  media(id: string): (Media & { ext: string; hidden: number }) | null {
    return (this.db.query('SELECT * FROM media WHERE id = ?').get(id) as any) ?? null
  }
  mediaPath(m: { id: string; ext: string }) {
    return join(this.mediaDir, `${m.id}.${m.ext}`)
  }
  /** Oldest files go first once the total passes the cap. */
  enforceDiskCap() {
    const cap = this.opts.maxBytes ?? 5 * 1024 ** 3
    let total = (this.db.query('SELECT COALESCE(SUM(bytes), 0) AS b FROM media').get() as Row).b as number
    if (total <= cap) return 0
    let removed = 0
    for (const m of this.db.query('SELECT id, ext, bytes FROM media ORDER BY created_at').all() as Row[]) {
      if (total <= cap * 0.9) break
      this.deleteMedia(m.id)
      total -= m.bytes
      removed += 1
    }
    return removed
  }
  deleteMedia(id: string) {
    const m = this.media(id)
    if (!m) return false
    rmSync(this.mediaPath(m), { force: true })
    this.db.query('DELETE FROM media WHERE id = ?').run(id)
    return true
  }
  /** History is 30 days; so is the community. */
  prune(days = 30) {
    const cut = this.now() - days * 86_400_000
    for (const m of this.db.query('SELECT id FROM media WHERE created_at < ?').all(cut) as Row[]) this.deleteMedia(m.id)
    this.db.query('DELETE FROM posts WHERE created_at < ?').run(cut)
    this.db.query('DELETE FROM flags WHERE at < ?').run(cut)
  }

  private ownMedia(residentId: string, ids: unknown): string[] | { error: string } {
    const list = Array.isArray(ids) ? [...new Set(ids.map(String))] : []
    if (list.length > 4) return { error: 'Four photos or videos at most.' }
    for (const id of list) {
      const m = this.media(id)
      if (!m || m.resident_id !== residentId) return { error: 'Upload the file first.' }
    }
    return list
  }
  private mediaView(ids: string[]) {
    return ids.flatMap((id) => {
      const m = this.media(id)
      return m && !m.hidden ? [{ id, kind: m.kind, url: `/m/${id}` }] : []
    })
  }

  // ---- posts (comments + chat) ---------------------------------------------------

  post(residentId: string, room: string, text: unknown, mediaIds: unknown): Post | { error: string } {
    const t = cleanText(text)
    if (typeof t !== 'string') return t
    const media = this.ownMedia(residentId, mediaIds)
    if (!Array.isArray(media)) return media
    if (!t && !media.length) return { error: 'Say something, or attach a photo or video.' }
    const id = newId(9)
    this.db.query('INSERT INTO posts (id, room, resident_id, text, media, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(id, room, residentId, t, JSON.stringify(media), this.now())
    return this.posts(room, { limit: 1, afterId: undefined, only: id })[0]!
  }
  posts(room: string, o: { after?: number; limit?: number; afterId?: string; only?: string; viewer?: string | null } = {}): Post[] {
    const rows = (
      o.only
        ? this.db.query('SELECT p.*, r.name FROM posts p JOIN residents r ON r.id = p.resident_id WHERE p.id = ?').all(o.only)
        : this.db.query('SELECT * FROM (SELECT p.*, r.name FROM posts p JOIN residents r ON r.id = p.resident_id WHERE p.room = ? AND p.hidden = 0 AND r.banned = 0 AND p.created_at > ? ORDER BY p.created_at DESC LIMIT ?) ORDER BY created_at').all(room, o.after ?? 0, Math.min(o.limit ?? 100, 200))
    ) as Row[]
    return rows.map((r) => ({ id: r.id, room: r.room, resident_id: r.resident_id, name: r.name, text: r.text, media: this.mediaView(JSON.parse(r.media)), created_at: r.created_at, ...(o.viewer ? { mine: r.resident_id === o.viewer } : {}) }))
  }
  commentCounts(incidentIds: string[]): Record<string, number> {
    if (!incidentIds.length) return {}
    const marks = incidentIds.map(() => '?').join(',')
    const rows = this.db.query(`SELECT room, COUNT(*) AS n FROM posts WHERE hidden = 0 AND room IN (${marks}) GROUP BY room`).all(...incidentIds.map((i) => `i:${i}`)) as Row[]
    return Object.fromEntries(rows.map((r) => [String(r.room).slice(2), r.n]))
  }
  deletePost(id: string, residentId?: string) {
    const r = residentId ? this.db.query('DELETE FROM posts WHERE id = ? AND resident_id = ?').run(id, residentId) : this.db.query('DELETE FROM posts WHERE id = ?').run(id)
    return r.changes > 0
  }

  // ---- residents' reports -------------------------------------------------------

  report(resident: Resident, b: { kind?: unknown; title?: unknown; detail?: unknown; lat?: unknown; lon?: unknown; media?: unknown }): Incident | { error: string } {
    const kind = KINDS.includes(b.kind as Kind) ? (b.kind as Kind) : null
    if (!kind) return { error: 'Pick what kind of incident it is.' }
    const title = cleanText(b.title)
    if (typeof title !== 'string' || title.length < 3 || title.length > 80) return { error: 'Give it a short title (3 to 80 characters).' }
    const detail = cleanText(b.detail)
    if (typeof detail !== 'string') return detail
    const lat = Number(b.lat)
    const lon = Number(b.lon)
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return { error: 'Put the pin where it is happening.' }
    const media = this.ownMedia(resident.id, b.media)
    if (!Array.isArray(media)) return media
    const id = `community:${newId(8)}`
    const inc: Incident = {
      id, source: 'community', kind, severity: 1, title, detail: detail.slice(0, 300), address: '', area: 'Resident report',
      lat: Math.round(lat * 1e5) / 1e5, lon: Math.round(lon * 1e5) / 1e5, at: this.now(), url: '',
    }
    this.store.upsertIncidents([inc])
    this.db.query('INSERT INTO reports (id, resident_id, media, created_at) VALUES (?, ?, ?, ?)').run(id, resident.id, JSON.stringify(media), this.now())
    return inc
  }
  reportInfo(id: string, viewer?: string | null) {
    const r = this.db.query('SELECT rp.*, rs.name FROM reports rp JOIN residents rs ON rs.id = rp.resident_id WHERE rp.id = ?').get(id) as Row | null
    if (!r || r.hidden) return null
    const confirms = (this.db.query('SELECT COUNT(*) AS n FROM confirms WHERE report_id = ?').get(id) as Row).n as number
    const confirmed = viewer ? Boolean(this.db.query('SELECT 1 FROM confirms WHERE report_id = ? AND resident_id = ?').get(id, viewer)) : false
    return { id, by: r.name, resident_id: r.resident_id, media: this.mediaView(JSON.parse(r.media)), confirms, confirmed, mine: viewer === r.resident_id, created_at: r.created_at }
  }
  /** Another resident vouches for it. Returns the new count and whether this one tipped it into alerting. */
  confirm(id: string, residentId: string): { confirms: number; alert: boolean } | { error: string } {
    const info = this.reportInfo(id)
    if (!info) return { error: 'not found' }
    if (info.resident_id === residentId) return { error: 'You reported it; others confirm it.' }
    this.db.query('INSERT OR IGNORE INTO confirms (report_id, resident_id, at) VALUES (?, ?, ?)').run(id, residentId, this.now())
    const confirms = this.reportInfo(id)!.confirms
    // Seen by three people (reporter + two): it may alert, once.
    const alert = confirms >= CONFIRMS_TO_ALERT && this.db.query('UPDATE reports SET alerted = 1 WHERE id = ? AND alerted = 0').run(id).changes > 0
    if (alert) this.store.db.query('UPDATE incidents SET severity = MAX(severity, 2), detail = ? WHERE id = ?').run(`Confirmed by ${confirms + 1} residents`, id)
    return { confirms, alert }
  }

  // ---- flags + admin --------------------------------------------------------------

  /** `post:<id>`, `media:<id>` or `report:<id>`. Three different residents hide it. */
  flag(target: string, residentId: string): { hidden: boolean } | { error: string } {
    const m = /^(post|media|report):([A-Za-z0-9_:-]{4,60})$/.exec(target)
    if (!m) return { error: 'bad target' }
    this.db.query('INSERT OR IGNORE INTO flags (target, resident_id, at) VALUES (?, ?, ?)').run(target, residentId, this.now())
    const n = (this.db.query('SELECT COUNT(*) AS n FROM flags WHERE target = ?').get(target) as Row).n as number
    if (n < FLAGS_TO_HIDE) return { hidden: false }
    this.hide(m[1]!, m[2]!)
    return { hidden: true }
  }
  hide(type: string, id: string) {
    if (type === 'post') this.db.query('UPDATE posts SET hidden = 1 WHERE id = ?').run(id)
    if (type === 'media') this.db.query('UPDATE media SET hidden = 1 WHERE id = ?').run(id)
    if (type === 'report') {
      this.db.query('UPDATE reports SET hidden = 1 WHERE id = ?').run(id)
      this.store.db.query('DELETE FROM incidents WHERE id = ?').run(id)
    }
  }
  remove(type: string, id: string) {
    if (type === 'media') return this.deleteMedia(id)
    if (type === 'post') return this.deletePost(id)
    if (type === 'report') return this.hide('report', id), true
    return false
  }
  stats() {
    const one = (sql: string) => (this.db.query(sql).get() as Row).n as number
    return { residents: one('SELECT COUNT(*) AS n FROM residents'), posts: one('SELECT COUNT(*) AS n FROM posts'), media: one('SELECT COUNT(*) AS n FROM media'), media_bytes: one('SELECT COALESCE(SUM(bytes), 0) AS n FROM media'), reports: one('SELECT COUNT(*) AS n FROM reports') }
  }
}

export const fileSize = (p: string) => {
  try {
    return statSync(p).size
  } catch {
    return -1
  }
}
