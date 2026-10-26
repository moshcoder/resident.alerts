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
import type { Pusher } from './push.js'
import { inShape, km, type Incident, type Kind, type Source } from './sources.js'

export const FRESH_MS = 30 * 60_000
export const PER_DEVICE_HOURLY = 20

const ICON: Record<Kind, string> = { police: '🚓', fire: '🔥', medical: '🚑', traffic: '🚗', weather: '⛈️', quake: '🌎', hazard: '⚠️', other: '📍' }

export const distanceText = (k: number) => (k < 0.16 ? 'nearby' : `${(k * 0.621371).toFixed(k < 16 ? 1 : 0)} mi`)

/** Which of a device's places an incident falls in (closest first), or null. */
export function matchPlace(d: Pick<Device, 'places' | 'kinds' | 'min_severity'>, i: Incident): { name: string; km: number } | null {
  if (!d.kinds.includes(i.kind) || i.severity < d.min_severity) return null
  let best: { name: string; km: number } | null = null
  for (const p of d.places) {
    const dist = km(p.lat, p.lon, i.lat, i.lon)
    const hit = i.shape ? inShape(p.lat, p.lon, i.shape) || dist <= p.km : dist <= p.km
    if (hit && (!best || dist < best.km)) best = { name: p.name, km: i.shape && inShape(p.lat, p.lon, i.shape) ? 0 : dist }
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

export type WorkerDeps = { store: Store; sources: Source[]; pusher: Pusher; geo?: Geocoder; fetch?: typeof fetch; log?: (...a: unknown[]) => void }

/** Push fresh incidents to every device they concern. Returns how many pushes went out. */
export async function fanOut(deps: Pick<WorkerDeps, 'store' | 'pusher'>, fresh: Incident[], now = Date.now()): Promise<number> {
  const recent = fresh.filter((i) => now - i.at <= FRESH_MS && i.at <= now + 5 * 60_000)
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

/** Read one source now: store, then push what is new. */
export async function readSource(deps: WorkerDeps, s: Source, opts: { first: boolean }) {
  const now = Date.now()
  try {
    const list = await s.read(deps.fetch ?? fetch, deps.geo)
    const fresh = deps.store.upsertIncidents(list)
    deps.store.recordRead(s.id, { ok: true, count: list.length, nextAt: now + s.everyMs })
    const pushed = opts.first ? 0 : await fanOut(deps, fresh)
    if (fresh.length || pushed) deps.log?.(`[${s.id}] ${list.length} read, ${fresh.length} new, ${pushed} pushed`)
    return { ok: true, read: list.length, fresh: fresh.length, pushed }
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
  const prune = setInterval(() => deps.log?.(`[prune] ${deps.store.prune(30)} old incidents removed`), 6 * 3600_000)
  return () => {
    stopped = true
    clearInterval(timer)
    clearInterval(prune)
  }
}
