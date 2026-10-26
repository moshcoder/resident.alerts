/**
 * California Highway Patrol: every incident on every state highway, from the
 * public CAD page (cad.chp.ca.gov/Traffic.aspx). It is an ASP.NET page, so one
 * read per dispatch center is: load the form, post the center, then post
 * "Details" for each row we have not seen to get its Lat/Lon and notes.
 *
 * Details are fetched once per incident and cached; an unchanged list costs two
 * requests per center. Times on the page are Pacific wall-clock without a date:
 * a time later than now (plus a little) means it started yesterday.
 */
import type { Database } from 'bun:sqlite'
import { classify, valid, zoned, type Incident, type Source } from './sources.js'

const URL_ = 'https://cad.chp.ca.gov/Traffic.aspx'
const UA = 'Mozilla/5.0 (compatible; resident.alerts/0.2; +https://resident.alerts.pit.world)'
export const CENTERS: Record<string, string> = {
  BFCC: 'Bakersfield', BSCC: 'Barstow', BICC: 'Bishop', BCCC: 'Border', CCCC: 'Capitol', CHCC: 'Chico', ECCC: 'El Centro', FRCC: 'Fresno',
  GGCC: 'Golden Gate', HMCC: 'Humboldt', ICCC: 'Indio', INCC: 'Inland', LACC: 'Los Angeles', MRCC: 'Merced', MYCC: 'Monterey', OCCC: 'Orange',
  RDCC: 'Redding', SACC: 'Sacramento', SLCC: 'San Luis Obispo', SKCCSTCC: 'Stockton', SUCC: 'Susanville', TKCC: 'Truckee', UKCC: 'Ukiah', VTCC: 'Ventura', YKCC: 'Yreka',
}

const ENT: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", nbsp: ' ' }
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&(#?\w+);/g, (m, e) => ENT[e] ?? m).replace(/\s+/g, ' ').trim()
const fields = (html: string) => Object.fromEntries([...html.matchAll(/name="(__[A-Z]+)"[^>]*value="([^"]*)"/g)].map((m) => [m[1]!, m[2]!.replace(/&amp;/g, '&')]))

export type ChpRow = { arg: string; number: string; time: string; type: string; location: string; desc: string; area: string }

export function parseList(html: string): ChpRow[] {
  const table = html.slice(html.indexOf('id="gvIncidents"'))
  const out: ChpRow[] = []
  for (const m of table.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)) {
    const arg = /__doPostBack\('gvIncidents','(Select\$\d+)'\)/.exec(m[1]!)?.[1]
    if (!arg) continue
    const c = [...m[1]!.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((x) => text(x[1]!))
    out.push({ arg, number: c[1] ?? '', time: c[2] ?? '', type: c[3] ?? '', location: c[4] ?? '', desc: c[5] ?? '', area: c[6] ?? '' })
  }
  return out
}

export function parseDetail(html: string): { lat: number; lon: number; notes: string[] } | null {
  const t = text(html)
  const m = /Lat\/Lon:\s*(-?\d+\.\d+)\s+(-?\d+\.\d+)/.exec(t)
  if (!m) return null
  const info = t.slice(t.indexOf('Detail Information') + 18, t.indexOf('Click on Details')).trim()
  // "8:13 PM 2 [6] LL BRDG 8:12 PM 1 [2] BLCKG #1 LN" -> one note per time stamp, newest first.
  const notes = info
    .split(/(?=\b\d{1,2}:\d{2} [AP]M\b)/)
    .map((s) => s.replace(/^\d{1,2}:\d{2} [AP]M\s+\d+\s+/, '').replace(/\[\d+\]\s*/g, '').replace(/\[Shared\]|-->|Unit Information|NO DETAILS/gi, '').replace(/^[,\s]+/, '').trim())
    .filter((s) => s.length > 2)
  return { lat: Number(m[1]), lon: Number(m[2]), notes: notes.slice(0, 4) }
}

/** "8:11 PM" on the CHP page -> epoch ms, today or (if that is in the future) yesterday, Pacific time. */
export function chpTime(clock: string, now = Date.now()): number {
  const m = /(\d{1,2}):(\d{2})\s*([AP]M)/i.exec(clock)
  if (!m) return NaN
  const h = (Number(m[1]) % 12) + (/pm/i.test(m[3]!) ? 12 : 0)
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(now))
  const at = zoned(`${day}T${String(h).padStart(2, '0')}:${m[2]}:00`, 'America/Los_Angeles')
  return at > now + 15 * 60_000 ? at - 86_400_000 : at
}

/** CHP's own wording for the worst ones: fatal, injury (not "no injuries"), SigAlert, wrong way, fire, full closure. */
export function chpSeverity(type: string, notes: string[], base: 1 | 2 | 3): 1 | 2 | 3 {
  const t = `${type} ${notes.join(' ')}`
  if (/fatal|1144|sigalert|wrong way|overturn|vehicle fire|car fire|full closure|ambulance responding/i.test(t)) return 3
  if (/injur/i.test(type) && !/no inj|unkn inj/i.test(type)) return 3
  return base
}

/** Keeps the ASP.NET session cookies between the three requests of one read. */
class Session {
  private cookies = new Map<string, string>()
  constructor(private readonly f: typeof fetch) {}
  async send(body?: Record<string, string>): Promise<string> {
    const r = await this.f(URL_, {
      method: body ? 'POST' : 'GET',
      headers: { 'user-agent': UA, ...(body ? { 'content-type': 'application/x-www-form-urlencoded' } : {}), ...(this.cookies.size ? { cookie: [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ') } : {}) },
      ...(body ? { body: new URLSearchParams(body).toString() } : {}),
      signal: AbortSignal.timeout(25_000),
    })
    for (const c of r.headers.getSetCookie?.() ?? []) {
      const [kv] = c.split(';')
      const i = kv!.indexOf('=')
      if (i > 0) this.cookies.set(kv!.slice(0, i).trim(), kv!.slice(i + 1).trim())
    }
    if (!r.ok) throw new Error(`cad.chp.ca.gov said ${r.status}`)
    return r.text()
  }
}

export function chpSource(db: Database, opts: { centers?: string[]; detailsPerRead?: number } = {}): Source {
  db.exec('CREATE TABLE IF NOT EXISTS chp_details (id TEXT PRIMARY KEY, lat REAL, lon REAL, notes TEXT, at INTEGER NOT NULL)')
  const centers = opts.centers ?? Object.keys(CENTERS)
  const perRead = opts.detailsPerRead ?? 400
  const cached = (id: string) => db.query('SELECT lat, lon, notes FROM chp_details WHERE id = ?').get(id) as { lat: number | null; lon: number | null; notes: string } | null
  const remember = (id: string, d: ReturnType<typeof parseDetail>) => db.query('INSERT OR REPLACE INTO chp_details (id, lat, lon, notes, at) VALUES (?, ?, ?, ?, ?)').run(id, d?.lat ?? null, d?.lon ?? null, JSON.stringify(d?.notes ?? []), Date.now())
  return {
    id: 'chp',
    name: 'California Highway Patrol incidents',
    area: 'California',
    center: [37.2, -119.5],
    km: 900,
    kinds: ['traffic', 'hazard', 'fire', 'police'],
    everyMs: 3 * 60_000,
    homepage: URL_,
    async read(f) {
      const out: Incident[] = []
      let budget = perRead
      let failures = 0
      db.query('DELETE FROM chp_details WHERE at < ?').run(Date.now() - 3 * 86_400_000)
      for (const center of centers) {
        try {
          const s = new Session(f)
          const form = fields(await s.send())
          const listHtml = await s.send({ ...form, __EVENTTARGET: 'ddlComCenter', __EVENTARGUMENT: '', ddlComCenter: center })
          const list = parseList(listHtml)
          const listForm = fields(listHtml)
          for (const row of list) {
            if (/^(Media|Traffic Advisory)$/i.test(row.location) || /^Traffic Advisory$/i.test(row.type)) continue
            const at = chpTime(row.time)
            const id = `${center}:${new Date(at).toISOString().slice(0, 10)}:${row.number}`
            let d = cached(id)
            if (!d && budget > 0) {
              budget -= 1
              const det = parseDetail(await s.send({ ...listForm, __EVENTTARGET: 'gvIncidents', __EVENTARGUMENT: row.arg, ddlComCenter: center }))
              remember(id, det)
              d = cached(id)
            }
            if (!d || d.lat === null || !valid(d.lat, d.lon!)) continue
            const c = classify(row.type, 'traffic')
            const notes: string[] = JSON.parse(d.notes || '[]')
            out.push({
              id: `chp:${id}`,
              source: 'chp',
              kind: /fire/i.test(row.type) ? 'fire' : c.kind === 'other' ? 'traffic' : c.kind,
              // CHP's own wording for the worst ones.
              severity: chpSeverity(row.type, notes, c.severity),
              title: row.type || 'Traffic incident',
              detail: [row.desc && row.desc !== row.location ? row.desc : '', notes[0] ?? ''].filter(Boolean).join(' · ').slice(0, 240),
              address: row.location,
              area: `${row.area || CENTERS[center]}, CA (CHP)`,
              lat: d.lat,
              lon: d.lon!,
              at,
              url: 'https://cad.chp.ca.gov/Traffic.aspx',
            })
          }
        } catch (e) {
          failures += 1
          if (failures === centers.length) throw e
        }
      }
      return out
    },
  }
}
