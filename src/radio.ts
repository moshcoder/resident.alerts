/**
 * Police and fire radio for wherever you are.
 *
 * The scanner audio itself is streamed by Broadcastify's volunteer feeds; we
 * find the ones for your county and link to their player. The steps:
 *   your point -> county (FCC Census Area API, free, no key)
 *   county -> Broadcastify's county page -> its live feeds, with listener counts
 *
 * State ids on Broadcastify are the state FIPS code; county ids are their own,
 * so we read the state page once a day to match the county by name. County
 * pages are cached for 30 minutes (feeds go on and offline).
 */
const UA = 'Mozilla/5.0 (compatible; resident.alerts/0.1; +https://resident.alerts.pit.world)'
const BASE = 'https://www.broadcastify.com'

export type Feed = { id: string; name: string; genre: string; online: boolean; listeners: number; url: string }
export type Radio = { county: string; state: string; stateCode: string; countyUrl: string | null; feeds: Feed[]; browse: string }

type Cached<T> = { at: number; value: T }
const ENT: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", nbsp: ' ' }
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&(#?\w+);/g, (m, e) => ENT[e] ?? m).replace(/\s+/g, ' ').trim()

/** Counties on a Broadcastify state page: name (without "County") -> ctid. */
export function parseStatePage(html: string): Map<string, string> {
  const out = new Map<string, string>()
  // Two shapes: plain links ("top counties") and the grid of every county.
  for (const m of html.matchAll(/<a href="\/listen\/ctid\/(\d+)">([^<]+)<\/a>/g)) out.set(normCounty(m[2]!), m[1]!)
  for (const m of html.matchAll(/href="\/listen\/ctid\/(\d+)"[^>]*>\s*<span class="portal-grid-card-name">([^<]+)<\/span>/g)) out.set(normCounty(m[2]!), m[1]!)
  return out
}

/** Feeds on a Broadcastify county page. */
export function parseCountyPage(html: string): Feed[] {
  // A county page can carry several tables (recent incidents, county feeds, wider feeds); read them all.
  const tables = (html.match(/<table[^>]*listen-feed-table[\s\S]*?<\/table>/gi) ?? []).join('')
  const feeds: Feed[] = []
  const seen = new Set<string>()
  for (const row of tables.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)) {
    const r = row[1]!
    const link = /<a href="\/listen\/feed\/(\d+)">([^<]+)<\/a>/.exec(r)
    if (!link || seen.has(link[1]!)) continue
    seen.add(link[1]!)
    const genre = text(/listen-genre-badge">([^<]*)</.exec(r)?.[1] ?? '')
    const listeners = Number(/data-sort-value="(\d+)"/.exec(r)?.[1] ?? 0)
    feeds.push({ id: link[1]!, name: text(link[2]!), genre, online: /portal-status-online/.test(r), listeners, url: `${BASE}/listen/feed/${link[1]}` })
  }
  // Public safety first, then the busiest.
  return feeds.sort((a, b) => Number(b.online) - Number(a.online) || Number(b.genre === 'Public Safety') - Number(a.genre === 'Public Safety') || b.listeners - a.listeners)
}

export const normCounty = (name: string) => String(name ?? '').toLowerCase().replace(/\b(county|parish|borough|census area|city and borough|municipality)\b/g, '').replace(/[^a-z]/g, '')

export class RadioFinder {
  private counties = new Map<string, Cached<{ county: string; fips: string; state: string; stateCode: string; stateFips: string } | null>>()
  private states = new Map<string, Cached<Map<string, string>>>()
  private feeds = new Map<string, Cached<Feed[]>>()
  constructor(private readonly f: typeof fetch = fetch) {}

  private async get(url: string, json = false): Promise<any> {
    const r = await this.f(url, { headers: { 'user-agent': UA, accept: json ? 'application/json' : 'text/html' }, signal: AbortSignal.timeout(15_000) })
    if (!r.ok) throw new Error(`${new URL(url).host} said ${r.status}`)
    return json ? r.json() : r.text()
  }

  /** County for a point, cached on a ~5 km grid. */
  async county(lat: number, lon: number) {
    const key = `${lat.toFixed(2)},${lon.toFixed(2)}`
    const hit = this.counties.get(key)
    if (hit && Date.now() - hit.at < 7 * 86_400_000) return hit.value
    const doc = await this.get(`https://geo.fcc.gov/api/census/area?lat=${lat}&lon=${lon}&censusYear=2020&format=json`, true)
    const r = doc?.results?.[0]
    const value = r ? { county: String(r.county_name), fips: String(r.county_fips), state: String(r.state_name), stateCode: String(r.state_code), stateFips: String(r.state_fips) } : null
    if (this.counties.size > 20_000) this.counties.clear()
    this.counties.set(key, { at: Date.now(), value })
    return value
  }

  private async stateCounties(stateFips: string) {
    const hit = this.states.get(stateFips)
    if (hit && Date.now() - hit.at < 86_400_000) return hit.value
    const value = parseStatePage(await this.get(`${BASE}/listen/stid/${Number(stateFips)}`))
    this.states.set(stateFips, { at: Date.now(), value })
    return value
  }

  private async countyFeeds(ctid: string) {
    const hit = this.feeds.get(ctid)
    if (hit && Date.now() - hit.at < 30 * 60_000) return hit.value
    const value = parseCountyPage(await this.get(`${BASE}/listen/ctid/${ctid}`))
    this.feeds.set(ctid, { at: Date.now(), value })
    return value
  }

  /** Radio for a point, or null outside the US. */
  async near(lat: number, lon: number): Promise<Radio | null> {
    const c = await this.county(lat, lon)
    if (!c) return null
    const ctid = (await this.stateCounties(c.stateFips)).get(normCounty(c.county))
    const feeds = ctid ? await this.countyFeeds(ctid) : []
    return { county: c.county, state: c.state, stateCode: c.stateCode, countyUrl: ctid ? `${BASE}/listen/ctid/${ctid}` : null, feeds, browse: `${BASE}/listen/stid/${Number(c.stateFips)}` }
  }
}
