/**
 * The resident.alerts API from anywhere: the CLI, the TUI and the MCP server
 * use this. RESIDENTALERTS_URL points it at another instance. The API is open;
 * RESIDENTALERTS_KEY (a Premium key) adds history past 24 hours.
 */
import type { Radio } from './radio.js'
import type { Incident, Kind } from './sources.js'
import type { Conditions } from './wildfire.js'

export const DEFAULT_URL = 'https://resident.alerts.pit.world'
export type ApiIncident = Incident & { distance_km: number | null }
export type ApiSource = { id: string; name: string; area: string; kinds: Kind[]; city: boolean; last_ok: number | null; last_error: string | null; last_24h: number }
export type ApiPost = { id: string; name: string; text: string; media: { id: string; kind: string; url: string }[]; created_at: number }
export type Fires = { count: number; fires: ApiIncident[]; evacuations: ApiIncident[]; warnings: ApiIncident[] }
export type Query = { lat?: number; lon?: number; km?: number; hours?: number; kinds?: Kind[]; minSeverity?: 1 | 2 | 3; limit?: number }

export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message)
  }
}

export class AlertsClient {
  readonly base: string
  constructor(base = process.env.RESIDENTALERTS_URL ?? DEFAULT_URL, private readonly doFetch: typeof fetch = fetch) {
    this.base = base.replace(/\/+$/, '')
  }

  private async get<T>(path: string): Promise<T> {
    const headers: Record<string, string> = { accept: 'application/json', 'user-agent': 'residentalerts-cli' }
    // RESIDENTALERTS_KEY (a Premium key) opens history past 24 hours.
    if (process.env.RESIDENTALERTS_KEY) headers['x-premium-key'] = process.env.RESIDENTALERTS_KEY
    const r = await this.doFetch(`${this.base}/api/v1${path}`, { headers, signal: AbortSignal.timeout(20_000) })
    const body = (await r.json().catch(() => ({}))) as any
    if (!r.ok) throw new ApiError(body?.error ?? `HTTP ${r.status}`, r.status)
    return body as T
  }

  async incidents(q: Query = {}): Promise<ApiIncident[]> {
    const p = new URLSearchParams()
    if (q.lat !== undefined && q.lon !== undefined) p.set('lat', String(q.lat)), p.set('lon', String(q.lon))
    if (q.km) p.set('km', String(q.km))
    if (q.hours) p.set('hours', String(q.hours))
    if (q.kinds?.length) p.set('kinds', q.kinds.join(','))
    if (q.minSeverity) p.set('min_severity', String(q.minSeverity))
    if (q.limit) p.set('limit', String(q.limit))
    return (await this.get<{ incidents: ApiIncident[] }>(`/incidents?${p}`)).incidents
  }
  incident(id: string) {
    return this.get<Incident & { page: string }>(`/incidents/${encodeURIComponent(id)}`)
  }
  /** Active fires (with perimeters), evacuation zones and red flag warnings near a point, or everywhere. */
  fires(lat?: number, lon?: number, km = 150) {
    return this.get<Fires>(lat !== undefined && lon !== undefined ? `/fires?lat=${lat}&lon=${lon}&km=${km}` : '/fires')
  }
  conditions(lat: number, lon: number) {
    return this.get<Conditions>(`/conditions?lat=${lat}&lon=${lon}`)
  }
  radio(lat: number, lon: number) {
    return this.get<Radio>(`/radio?lat=${lat}&lon=${lon}`)
  }
  async comments(id: string): Promise<ApiPost[]> {
    return (await this.get<{ posts: ApiPost[] }>(`/incidents/${encodeURIComponent(id)}/comments`)).posts
  }
  async chat(lat: number, lon: number): Promise<ApiPost[]> {
    return (await this.get<{ posts: ApiPost[] }>(`/chat?lat=${lat}&lon=${lon}`)).posts
  }
  async sources(): Promise<ApiSource[]> {
    return (await this.get<{ sources: ApiSource[] }>('/sources')).sources
  }
}

const ICON: Record<string, string> = { police: '🚓', fire: '🔥', medical: '🚑', traffic: '🚗', weather: '⛈️', quake: '🌎', hazard: '⚠️', other: '📍' }

export function when(at: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - at) / 1000))
  if (s < 60) return 'now'
  if (s < 3600) return `${Math.round(s / 60)}m`
  if (s < 86_400) return `${Math.round(s / 3600)}h`
  return `${Math.round(s / 86_400)}d`
}

/** One line per incident, for the CLI and the TUI. */
export function incidentLine(i: ApiIncident, now = Date.now()): string {
  const dist = i.distance_km == null ? '' : ` ${(i.distance_km * 0.621371).toFixed(1)}mi`
  return `${when(i.at, now).padStart(3)}${dist.padStart(7)}  ${ICON[i.kind] ?? '📍'} ${i.severity === 3 ? '!' : ' '} ${i.title}  ·  ${i.address || i.area}`
}
