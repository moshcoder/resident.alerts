/**
 * `residentalerts watch <lat> <lon>`: a live terminal view of what is happening
 * around a point. It reloads every 30 s; new calls are marked.
 *
 * ↑/↓ picks a call, s toggles serious-only, +/- widens or narrows the radius,
 * r reloads, q quits.
 */
import { createApp } from '@profullstack/hqtui'
import { AlertsClient, incidentLine, type ApiIncident, type Query } from './client.js'

export type TuiState = { list: ApiIncident[]; seen: Set<string>; fresh: Set<string>; at: number; km: number; serious: boolean; busy: boolean; error: string | null; loadedAt: number }
export const initialState = (km = 3): TuiState => ({ list: [], seen: new Set(), fresh: new Set(), at: 0, km, serious: false, busy: false, error: null, loadedAt: 0 })

/** Pure key handling, testable without a terminal. */
export function onKey(s: TuiState, key: { name: string; key: string; char?: string }): 'quit' | 'reload' | null {
  const n = s.list.length
  if (key.key === 'ctrl+c' || key.name === 'escape' || key.char === 'q') return 'quit'
  if (key.name === 'down' || key.char === 'j') return n && (s.at = (s.at + 1) % n), null
  if (key.name === 'up' || key.char === 'k') return n && (s.at = (s.at + n - 1) % n), null
  if (key.char === 's') return (s.serious = !s.serious), 'reload'
  if (key.char === '+' || key.char === '=') return (s.km = Math.min(80, Math.round(s.km * 1.5 * 10) / 10)), 'reload'
  if (key.char === '-') return (s.km = Math.max(0.5, Math.round((s.km / 1.5) * 10) / 10)), 'reload'
  if (key.char === 'r') return 'reload'
  return null
}

/** Mark what we have not seen before (nothing is "new" on the first load). */
export function absorb(s: TuiState, list: ApiIncident[]) {
  const first = s.loadedAt === 0
  s.fresh = new Set(first ? [] : list.filter((i) => !s.seen.has(i.id)).map((i) => i.id))
  for (const i of list) s.seen.add(i.id)
  s.list = list
  s.at = Math.min(s.at, Math.max(0, list.length - 1))
  s.loadedAt = Date.now()
}

export async function runTui(client = new AlertsClient(), q: Query = {}): Promise<void> {
  if (q.lat === undefined) throw new Error('usage: residentalerts watch <lat> <lon> [--km 3]')
  const s = initialState(q.km ?? 3)
  const app = await createApp({ title: 'resident.alerts', quitKeys: [] })
  const load = async () => {
    s.busy = true
    app.invalidate()
    try {
      absorb(s, await client.incidents({ ...q, km: s.km, hours: q.hours ?? 6, ...(s.serious ? { minSeverity: 3 } : {}), limit: 200 }))
      s.error = null
    } catch (e) {
      s.error = e instanceof Error ? e.message : String(e)
    } finally {
      s.busy = false
      app.invalidate()
    }
  }
  void load()
  const timer = setInterval(() => !s.busy && void load(), 30_000)
  app.on('key', (event: any) => {
    const action = onKey(s, event)
    if (action === 'quit') {
      clearInterval(timer)
      app.quit()
    } else if (action === 'reload') void load()
    app.invalidate()
  })
  app.render(({ ui, theme }: any) => {
    ui.row({ size: 1 }, (h: any) => {
      h.text(' resident.alerts', { fg: theme.accent, bold: true, size: 17 })
      h.text(`${q.lat!.toFixed(3)}, ${q.lon!.toFixed(3)} · ${(s.km * 0.621371).toFixed(1)} mi · last ${q.hours ?? 6}h${s.serious ? ' · serious only' : ''}`, { fg: theme.muted })
      h.text(`${s.list.length} calls `, { fg: theme.muted, align: 'right' })
    })
    ui.panel({ title: 'Nearby' }, (p: any) => {
      if (s.error) p.text(s.error, { fg: theme.danger ?? theme.accent })
      if (s.loadedAt && !s.list.length) p.text('Nothing reported here. Press + to widen the radius.', { fg: theme.muted })
      s.list.forEach((i, n) => {
        const fresh = s.fresh.has(i.id)
        p.text(`${n === s.at ? '›' : ' '}${fresh ? '●' : ' '}${incidentLine(i)}`, { fg: n === s.at ? theme.accent : i.severity === 3 ? (theme.danger ?? theme.text) : theme.text, bold: n === s.at || fresh })
      })
    })
    const cur = s.list[s.at]
    if (cur) {
      ui.panel({ title: cur.title }, (p: any) => {
        p.text(`${cur.address || cur.area} · ${new Date(cur.at).toLocaleString()}`, { fg: theme.text })
        if (cur.detail) p.text(cur.detail, { fg: theme.muted })
        p.text(`${client.base}/i/${encodeURIComponent(cur.id)}`, { fg: theme.muted })
      })
    }
    ui.statusBar({ items: [{ key: 's', label: 'serious only' }, { key: '+/-', label: 'radius' }, { key: 'r', label: 'reload' }, { key: 'q', label: 'quit' }], right: [{ label: s.busy ? 'loading…' : 'live, every 30 s' }] })
  })
  await app.start()
}
