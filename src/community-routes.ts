/**
 * HTTP for the community: residents, uploads, comments, area chat, residents'
 * reports, flags and the admin key. Everything under /api/v1 takes the
 * resident token as `Authorization: Bearer rt_…`; there are no cookies, so a
 * cross-site page cannot post as you.
 */
import type { Context, Hono } from 'hono'
import { AREA_ROOM, areaRoom, cleanName, CONFIRMS_TO_ALERT, VIDEO_MAX, type Community, type Resident } from './community.js'
import type { Store } from './db.js'
import type { Pusher } from './push.js'
import { fanOut } from './worker.js'

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

const HOUR = 3600_000
const DAY = 24 * HOUR

export function mountCommunity(app: Hono, api: Hono, deps: { store: Store; community: Community; pusher: Pusher; userOf?: (c: Context) => { id: string } | null; banUser?: (id: string) => void }) {
  const { community: cm, store } = deps
  const ip = (c: Context) => c.req.header('x-real-ip') ?? 'local'
  const token = (c: Context) => (c.req.header('authorization') ?? '').replace(/^Bearer\s+/i, '') || c.req.header('x-resident-token')
  const me = (c: Context): Resident | null => (cm.networkBanned(ip(c)) ? null : cm.byToken(token(c)))
  const need = (c: Context) => c.json({ error: 'pick a name first: POST /api/v1/residents' }, 401)
  const json = async (c: Context) => ((await c.req.json().catch(() => ({}))) ?? {}) as Record<string, any>
  const postBurst = new Limiter(8, 60_000)
  const joinLimit = new Limiter(5, HOUR)

  // ---- residents ---------------------------------------------------------------
  // Posting needs an account (when accounts are on): the token comes from a signed-in session.
  api.post('/residents', async (c) => {
    if (cm.networkBanned(ip(c))) return c.json({ error: 'posting is closed from this network' }, 403)
    const user = deps.userOf ? deps.userOf(c) : null
    if (deps.userOf && !user) return c.json({ error: 'sign in with your email to post', signin: '/signin' }, 401)
    if (!joinLimit.allow(`join:${ip(c)}`) || (!user && cm.residentsFrom(ip(c), Date.now() - DAY) >= 10)) return c.json({ error: 'too many new names from here today' }, 429)
    const b = await json(c)
    const name = b.name === undefined || b.name === '' ? null : cleanName(b.name)
    if (b.name && !name) return c.json({ error: 'Names are 2 to 30 letters, numbers, spaces, . _ \' -, and cannot claim to be official.' }, 400)
    const { resident, token } = user ? cm.residentForUser(user.id, name, ip(c)) : cm.newResident(name, ip(c))
    return c.json({ token, resident: { id: resident.id, name: resident.name } }, 201)
  })
  api.get('/residents/me', (c) => {
    const r = me(c)
    return r ? c.json({ id: r.id, name: r.name, created_at: r.created_at }) : need(c)
  })
  api.patch('/residents/me', async (c) => {
    const r = me(c)
    if (!r) return need(c)
    const name = cleanName((await json(c)).name)
    if (!name) return c.json({ error: 'Names are 2 to 30 letters, numbers, spaces, . _ \' -, and cannot claim to be official.' }, 400)
    cm.rename(r.id, name)
    return c.json({ id: r.id, name })
  })

  // ---- uploads ---------------------------------------------------------------
  api.post('/media', async (c) => {
    const r = me(c)
    if (!r) return need(c)
    if (cm.countSince('media', r.id, Date.now() - HOUR) >= 10 || cm.countSince('media', r.id, Date.now() - DAY) >= 30) return c.json({ error: 'upload limit: 10 an hour, 30 a day' }, 429)
    if (Number(c.req.header('content-length') ?? 0) > VIDEO_MAX + 64 * 1024) return c.json({ error: 'Videos up to 25 MB, photos up to 10 MB.' }, 413)
    const form = await c.req.parseBody().catch(() => null)
    const file = form?.file
    if (!(file instanceof File)) return c.json({ error: 'send the file as multipart field "file"' }, 400)
    const out = await cm.addMedia(r.id, new Uint8Array(await file.arrayBuffer()))
    if ('error' in out) return c.json(out, 400)
    return c.json({ id: out.id, kind: out.kind, url: `/m/${out.id}` }, 201)
  })

  // The file itself. Sandboxed, typed by what we sniffed, ranged for video seeking (iOS needs it).
  app.get('/m/:id{[A-Za-z0-9_-]{8,24}}', async (c) => {
    const m = cm.media(c.req.param('id'))
    if (!m || m.hidden) return c.text('not found', 404)
    const file = Bun.file(cm.mediaPath(m))
    if (!(await file.exists())) return c.text('not found', 404)
    const size = file.size
    const headers: Record<string, string> = {
      'content-type': m.mime,
      'cache-control': 'public, max-age=86400',
      'accept-ranges': 'bytes',
      'content-security-policy': "default-src 'none'; sandbox",
      'x-content-type-options': 'nosniff',
      'cross-origin-resource-policy': 'same-origin',
    }
    const range = /^bytes=(\d*)-(\d*)$/.exec(c.req.header('range') ?? '')
    if (range && (range[1] || range[2])) {
      let start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]))
      let end = range[1] && range[2] ? Number(range[2]) : size - 1
      end = Math.min(end, size - 1)
      if (start > end || start >= size) return c.body(null, 416, { 'content-range': `bytes */${size}` })
      start = Math.max(0, start)
      return c.body(await file.slice(start, end + 1).arrayBuffer(), 206, { ...headers, 'content-range': `bytes ${start}-${end}/${size}`, 'content-length': String(end - start + 1) })
    }
    return c.body(await file.arrayBuffer(), 200, headers)
  })

  // ---- posting (shared by comments and chat) ----------------------------------------
  const say = async (c: Context, room: string) => {
    const r = me(c)
    if (!r) return need(c)
    if (!postBurst.allow(`post:${r.id}`) || cm.countSince('posts', r.id, Date.now() - DAY) >= 150) return c.json({ error: 'slow down a little' }, 429)
    const b = await json(c)
    const out = cm.post(r.id, room, b.text, b.media)
    return 'error' in out ? c.json(out, 400) : c.json({ ...out, mine: true }, 201)
  }
  const listen = (c: Context, room: string) => c.json({ room, posts: cm.posts(room, { after: Number(c.req.query('after') ?? 0) || 0, limit: Number(c.req.query('limit') ?? 100) || 100, viewer: me(c)?.id ?? null }) })

  api.get('/incidents/:id/comments', (c) => (store.incident(c.req.param('id')) ? listen(c, `i:${c.req.param('id')}`) : c.json({ error: 'not found' }, 404)))
  api.post('/incidents/:id/comments', (c) => (store.incident(c.req.param('id')) ? say(c, `i:${c.req.param('id')}`) : c.json({ error: 'not found' }, 404)))

  const roomAt = (c: Context, b?: Record<string, any>) => {
    const lat = Number(b?.lat ?? c.req.query('lat'))
    const lon = Number(b?.lon ?? c.req.query('lon'))
    const named = String(b?.room ?? c.req.query('room') ?? '')
    if (AREA_ROOM.test(named)) return named
    return Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180 ? areaRoom(lat, lon) : null
  }
  api.get('/chat', (c) => {
    const room = roomAt(c)
    return room ? listen(c, room) : c.json({ error: 'lat and lon (or room) are required' }, 400)
  })
  api.post('/chat', async (c) => {
    const b = await c.req.raw.clone().json().catch(() => ({}))
    const room = roomAt(c, b)
    return room ? say(c, room) : c.json({ error: 'lat and lon (or room) are required' }, 400)
  })
  api.delete('/posts/:id', (c) => {
    const r = me(c)
    if (!r) return need(c)
    return c.json({ deleted: cm.deletePost(c.req.param('id'), r.id) })
  })

  // ---- residents' reports -----------------------------------------------------------
  api.post('/reports', async (c) => {
    const r = me(c)
    if (!r) return need(c)
    if (cm.countSince('reports', r.id, Date.now() - HOUR) >= 4 || cm.countSince('reports', r.id, Date.now() - DAY) >= 15) return c.json({ error: 'report limit: 4 an hour' }, 429)
    const out = cm.report(r, await json(c))
    return 'error' in out ? c.json(out, 400) : c.json({ ...out, page: `/i/${encodeURIComponent(out.id)}` }, 201)
  })
  api.get('/reports/:id', (c) => {
    const info = cm.reportInfo(c.req.param('id'), me(c)?.id ?? null)
    return info ? c.json({ ...info, resident_id: undefined }) : c.json({ error: 'not found' }, 404)
  })
  api.post('/reports/:id/confirm', async (c) => {
    const r = me(c)
    if (!r) return need(c)
    const out = cm.confirm(c.req.param('id'), r.id)
    if ('error' in out) return c.json(out, out.error === 'not found' ? 404 : 400)
    if (out.alert) {
      const inc = store.incident(c.req.param('id'))
      // Confirmed by enough people: alert like any other call, as if it had just come in.
      if (inc) await fanOut({ store, pusher: deps.pusher }, [{ ...inc, at: Date.now(), title: `${inc.title} (resident report)` }])
    }
    return c.json({ confirms: out.confirms, needed: CONFIRMS_TO_ALERT, alerted: out.alert })
  })

  // ---- flags + admin ---------------------------------------------------------------
  api.post('/flag', async (c) => {
    const r = me(c)
    if (!r) return need(c)
    const out = cm.flag(String((await json(c)).target ?? ''), r.id)
    return 'error' in out ? c.json(out, 400) : c.json(out)
  })
  const admin = (c: Context) => cm.isAdmin(c.req.header('x-admin-key'))
  api.post('/admin/remove', async (c) => {
    if (!admin(c)) return c.json({ error: 'forbidden' }, 403)
    const m = /^(post|media|report):(.+)$/.exec(String((await json(c)).target ?? ''))
    return m ? c.json({ removed: cm.remove(m[1]!, m[2]!) }) : c.json({ error: 'target is post:<id>, media:<id> or report:<id>' }, 400)
  })
  api.post('/admin/ban', async (c) => {
    if (!admin(c)) return c.json({ error: 'forbidden' }, 403)
    const id = String((await json(c)).resident_id ?? '')
    const user = cm.userOf(id)
    const banned = cm.ban(id)
    // The account goes too, so a new sign-in with the same email cannot post again.
    if (banned && user) deps.banUser?.(user)
    return c.json({ banned })
  })
  api.get('/admin/stats', (c) => (admin(c) ? c.json(cm.stats()) : c.json({ error: 'forbidden' }, 403)))
}
