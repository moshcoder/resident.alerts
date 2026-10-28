/**
 * The loop: read each source when it is due, keep what it returns, and push
 * anything new to the devices whose places it falls in.
 *
 * A source's first read after a start only fills the map: pushing a day of
 * backlog at everyone would be noise. After that, an incident alerts only if it
 * is new to us AND was reported in the last 30 minutes (feeds publish late, and
 * a call from three hours ago is history, not an alert).
 */
import type { Device, Store } from './db.js'
import type { Geocoder } from './geocode.js'
import type { AccountAlerts } from './hooks.js'
import type { Pusher } from './push.js'
import { inShape, km, type Incident, type Kind, type Source } from './sources.js'

export const FRESH_MS = 30 * 60_000
export const PER_DEVICE_HOURLY = 20

const ICON: Record<Kind, string> = { police: '🚓', fire: '🔥', medical: '🚑', traffic: '🚗', weather: '⛈️', quake: '🌎', hazard: '⚠️', other: '📍' }

export const distanceText = (k: number) => (k < 0.16 ? 'nearby' : `${(k * 0.621371).toFixed(k < 16 ? 1 : 0)} mi`)

/** Distance to the nearest point on an area's outline, on a flat local projection (fine at alert-radius scale). */
export function edgeKm(lat: number, lon: number, rings: [number, number][][]): number {
  const kx = 111.32 * Math.cos((lat * Math.PI) / 180)
  const ky = 110.57
  let best = Infinity
  for (const ring of rings) {
    for (let n = 1; n < ring.length; n++) {
      const ax = (ring[n - 1]![1] - lon) * kx, ay = (ring[n - 1]![0] - lat) * ky
      const bx = (ring[n]![1] - lon) * kx, by = (ring[n]![0] - lat) * ky
      const dx = bx - ax, dy = by - ay
      const t = dx || dy ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / (dx * dx + dy * dy))) : 0
      best = Math.min(best, Math.hypot(ax + t * dx, ay + t * dy))
    }
  }
  return best
}

/** Which of a device's places an incident falls in (closest first), or null. */
export function matchPlace(d: Pick<Device, 'places' | 'kinds' | 'min_severity'>, i: Incident): { name: string; km: number } | null {
  if (!d.kinds.includes(i.kind) || i.severity < d.min_severity) return null
  let best: { name: string; km: number } | null = null
  for (const p of d.places) {
    // An area (a fire's perimeter, a warning, a zone) is as close as its nearest edge, and 0 when you are inside it.
    const dist = i.shape ? (inShape(p.lat, p.lon, i.shape) ? 0 : Math.min(km(p.lat, p.lon, i.lat, i.lon), edgeKm(p.lat, p.lon, i.shape))) : km(p.lat, p.lon, i.lat, i.lon)
    if (dist <= p.km && (!best || dist < best.km)) best = { name: p.name, km: dist }
  }
  return best
}

export function message(i: Incident, place: { name: string; km: number }) {
  const where = place.km === 0 && i.shape ? `covers ${place.name}` : `${distanceText(place.km)} from ${place.name}`
  return {
    title: `${ICON[i.kind]} ${i.title}`,
    body: [i.address, where, i.detail].filter(Boolean).join(' · ').slice(0, 240),
    url: `/i/${encodeURIComponent(i.id)}`,
    tag: i.id,
    urgent: i.severity >= 3,
  }
}

export type WorkerDeps = { store: Store; sources: Source[]; pusher: Pusher; geo?: Geocoder; fetch?: typeof fetch; log?: (...a: unknown[]) => void; alerts?: AccountAlerts }

/**
 * Push fresh incidents to every device they concern. Returns how many pushes went out.
 * `anyAge` is for a fire that grew: it started long ago, but its edge only now reaches a place.
 */
export async function fanOut(deps: Pick<WorkerDeps, 'store' | 'pusher'>, fresh: Incident[], now = Date.now(), anyAge = false): Promise<number> {
  const recent = anyAge ? fresh : fresh.filter((i) => now - i.at <= FRESH_MS && i.at <= now + 5 * 60_000)
  if (!recent.length || !deps.pusher.enabled) return 0
  let sent = 0
  for (const d of deps.store.devices()) {
    let budget = PER_DEVICE_HOURLY - deps.store.sentSince(d.id, now - 3600_000)
    // Most serious first, so a quota never swallows the shooting for a fender-bender.
    for (const i of [...recent].sort((a, b) => b.severity - a.severity || b.at - a.at)) {
      if (budget <= 0) break
      const place = matchPlace(d, i)
      if (!place || !deps.store.markSent(d.id, i.id)) continue
      budget -= 1
      if (await deps.pusher.send(d, message(i, place))) sent += 1
    }
  }
  return sent
}

/** What changed on a followed incident, as a push. */
export function followMessage(i: Incident, ended: boolean) {
  return {
    title: ended ? `✅ ${i.title}: ${i.source === 'evac' ? 'lifted' : 'no longer listed as active'}` : `${ICON[i.kind]} Update: ${i.title}`,
    body: (ended ? [i.address] : [i.detail, i.address]).filter(Boolean).join(' · ').slice(0, 240),
    url: `/i/${encodeURIComponent(i.id)}`,
    tag: `${i.id}#follow`,
    urgent: !ended && i.severity >= 3,
  }
}

export const followDigest = (i: Incident, ended: boolean) => (ended ? 'ended' : `${i.severity}|${i.title}|${i.detail}`).replace(/[^\w%|.]+/g, '').slice(0, 120)

/** Tell the devices following an incident that it changed or ended. */
export async function notifyFollowers(deps: Pick<WorkerDeps, 'store' | 'pusher'>, changed: Incident[], ended: Incident[], now = Date.now()): Promise<number> {
  if ((!changed.length && !ended.length) || !deps.pusher.enabled) return 0
  const events = [...changed.map((i) => ({ i, ended: false })), ...ended.map((i) => ({ i, ended: true }))]
  let sent = 0
  for (const d of deps.store.devices()) {
    if (!d.follows.length) continue
    let budget = PER_DEVICE_HOURLY - deps.store.sentSince(d.id, now - 3600_000)
    for (const e of events) {
      if (budget <= 0) break
      // The same numbers never go out twice, even if a feed flips back and forth.
      if (!d.follows.includes(e.i.id) || !deps.store.markSent(d.id, `${e.i.id}#${followDigest(e.i, e.ended)}`)) continue
      budget -= 1
      if (await deps.pusher.send(d, followMessage(e.i, e.ended))) sent += 1
    }
  }
  return sent
}

/** The same news for accounts' webhooks. Never in the way of reading a feed. */
export async function accountWebhooks(alerts: AccountAlerts, fresh: Incident[], changed: Incident[], ended: Incident[], log?: (...a: unknown[]) => void): Promise<number> {
  try {
    // Changes first: a fire that only now reaches a place is news (issued), not an update.
    let n = await alerts.changed(changed, ended)
    n += await alerts.issued(fresh)
    n += await alerts.issued(changed.filter((i) => i.kind === 'fire' && i.shape), true)
    return n
  } catch (e) {
    log?.(`[webhooks] ${e instanceof Error ? e.message : String(e)}`)
    return 0
  }
}

/** Read one source now: store, then push what is new. */
export async function readSource(deps: WorkerDeps, s: Source, opts: { first: boolean }) {
  const now = Date.now()
  try {
    const list = await s.read(deps.fetch ?? fetch, deps.geo)
    const { fresh, changed, ended } = deps.store.sync(list, s.live ? { live: s.id } : {})
    deps.store.recordRead(s.id, { ok: true, count: list.length, nextAt: now + s.everyMs })
    let pushed = 0
    if (!opts.first) {
      pushed += await fanOut(deps, fresh)
      // A fire that grew may now reach a place it did not before; each place hears about a fire once.
      pushed += await fanOut(deps, changed.filter((i) => i.kind === 'fire' && i.shape), now, true)
      pushed += await notifyFollowers(deps, changed, ended, now)
    }
    const hooked = opts.first || !deps.alerts ? 0 : await accountWebhooks(deps.alerts, fresh, changed, ended, deps.log)
    if (fresh.length || pushed || hooked) deps.log?.(`[${s.id}] ${list.length} read, ${fresh.length} new, ${pushed} pushed${hooked ? `, ${hooked} to webhooks` : ''}`)
    return { ok: true, read: list.length, fresh: fresh.length, pushed, hooked }
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e)
    // Back off a failing source: twice its interval, up to 15 minutes.
    deps.store.recordRead(s.id, { ok: false, error, nextAt: now + Math.min(s.everyMs * 2, 15 * 60_000) })
    deps.log?.(`[${s.id}] failed: ${error}`)
    return { ok: false, error }
  }
}

export function startWorker(deps: WorkerDeps): () => void {
  const running = new Set<string>()
  let stopped = false
  const tick = () => {
    if (stopped) return
    const now = Date.now()
    for (const s of deps.sources) {
      const state = deps.store.sourceState(s.id)
      if (running.has(s.id) || state.next_at > now) continue
      running.add(s.id)
      // Only a source's very first read is silent; after a restart, anything we
      // did not already have and that is still fresh alerts as usual.
      void readSource(deps, s, { first: state.last_ok === 0 }).finally(() => running.delete(s.id))
    }
  }
  tick()
  const timer = setInterval(tick, 15_000)
  const prune = setInterval(() => {
    deps.log?.(`[prune] ${deps.store.prune(30)} old incidents removed`)
    deps.alerts?.prune(30)
  }, 6 * 3600_000)
  return () => {
    stopped = true
    clearInterval(timer)
    clearInterval(prune)
  }
}
