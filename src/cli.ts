/**
 * `residentalerts`: live 911 incidents from the terminal.
 *
 *   residentalerts near <lat> <lon> [--km 3] [--hours 6] [--kinds police,fire] [--serious] [--json]
 *   residentalerts serious [--hours 1] [--json]       serious calls everywhere we cover
 *   residentalerts show <id> [--json]
 *   residentalerts radio <lat> <lon> [--json]
 *   residentalerts sources [--json]
 *   residentalerts comments <id> [--json]             what neighbors said about an incident
 *   residentalerts chat <lat> <lon> [--json]          the area chat there
 *   residentalerts watch <lat> <lon> [--km 3]         live terminal view (also: residentalerts tui)
 *   residentalerts mcp                                 MCP server on stdio
 *   residentalerts serve                               run the web server yourself
 */
import { AlertsClient, incidentLine, when, type Query } from './client.js'
import { KINDS, type Kind } from './sources.js'
import { VERSION } from './version.js'

const HELP = `residentalerts ${VERSION}: live 911 incidents near you (https://resident.alerts.pit.world)

  residentalerts near <lat> <lon> [--km 3] [--hours 6] [--kinds police,fire] [--serious] [--json]
  residentalerts serious [--hours 1] [--json]
  residentalerts show <id> [--json]
  residentalerts radio <lat> <lon> [--json]
  residentalerts sources [--json]
  residentalerts comments <id> [--json]
  residentalerts chat <lat> <lon> [--json]
  residentalerts watch <lat> <lon> [--km 3]     live terminal view
  residentalerts mcp                             MCP server on stdio
  residentalerts serve                           run the web server

RESIDENTALERTS_URL points at another instance.`

export function parseArgs(argv: string[]): { pos: string[]; flags: Record<string, string | true> } {
  const pos: string[] = []
  const flags: Record<string, string | true> = {}
  for (let n = 0; n < argv.length; n++) {
    const a = argv[n]!
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('=')
      const next = argv[n + 1]
      if (v !== undefined) flags[k!] = v
      else if (next !== undefined && !next.startsWith('--') && !['json', 'serious'].includes(k!)) flags[k!] = argv[++n]!
      else flags[k!] = true
    } else pos.push(a)
  }
  return { pos, flags }
}

export function queryFrom(pos: string[], flags: Record<string, string | true>): Query {
  const q: Query = {}
  if (pos.length >= 2) {
    const lat = Number(pos[0])
    const lon = Number(pos[1])
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) throw new Error('lat and lon must be numbers, like 47.61 -122.33')
    q.lat = lat
    q.lon = lon
  }
  if (typeof flags.km === 'string') q.km = Number(flags.km)
  if (typeof flags.hours === 'string') q.hours = Number(flags.hours)
  if (typeof flags.kinds === 'string') q.kinds = flags.kinds.split(',').filter((k): k is Kind => KINDS.includes(k as Kind))
  if (flags.serious) q.minSeverity = 3
  if (typeof flags.limit === 'string') q.limit = Number(flags.limit)
  return q
}

export async function main(argv = process.argv.slice(2), out = (s: string) => console.log(s), client = new AlertsClient()): Promise<number> {
  const [cmd, ...rest] = argv
  const { pos, flags } = parseArgs(rest)
  const json = (v: unknown) => out(JSON.stringify(v, null, 2))
  try {
    switch (cmd) {
      case undefined:
      case 'help':
      case '--help':
      case '-h':
        out(HELP)
        return 0
      case '--version':
      case 'version':
        out(VERSION)
        return 0
      case 'near': {
        if (pos.length < 2) throw new Error('usage: residentalerts near <lat> <lon> [--km 3]')
        const list = await client.incidents({ km: 3, hours: 6, ...queryFrom(pos, flags) })
        if (flags.json) return json(list), 0
        out(list.length ? list.map((i) => incidentLine(i)).join('\n') : 'Nothing reported there.')
        return 0
      }
      case 'serious': {
        const list = await client.incidents({ hours: 1, ...queryFrom(pos, flags), minSeverity: 3 })
        if (flags.json) return json(list), 0
        out(list.length ? list.map((i) => `${incidentLine(i)}  (${i.area})`).join('\n') : 'Nothing serious reported.')
        return 0
      }
      case 'show': {
        if (!pos[0]) throw new Error('usage: residentalerts show <id>')
        const i = await client.incident(pos[0])
        if (flags.json) return json(i), 0
        out(`${i.title}\n${i.address}\n${new Date(i.at).toLocaleString()} (${when(i.at)} ago) · ${i.kind} · severity ${i.severity}${i.detail ? `\n${i.detail}` : ''}\n${i.page}`)
        return 0
      }
      case 'radio': {
        const q = queryFrom(pos, flags)
        if (q.lat === undefined) throw new Error('usage: residentalerts radio <lat> <lon>')
        const r = await client.radio(q.lat, q.lon!)
        if (flags.json) return json(r), 0
        out(`${r.county}, ${r.stateCode}`)
        for (const f of r.feeds) out(`  ${f.online ? '●' : '○'} ${f.name} (${f.listeners} listening)  ${f.url}`)
        if (!r.feeds.length) out('  no scanner feeds listed')
        return 0
      }
      case 'sources': {
        const list = await client.sources()
        if (flags.json) return json(list), 0
        for (const s of list) out(`${s.last_ok && Date.now() - s.last_ok < 30 * 60_000 ? '●' : '○'} ${s.name.padEnd(42)} ${s.area.padEnd(18)} ${String(s.last_24h).padStart(6)} in 24h`)
        return 0
      }
      case 'comments':
      case 'chat': {
        let posts
        if (cmd === 'comments') {
          if (!pos[0]) throw new Error('usage: residentalerts comments <id>')
          posts = await client.comments(pos[0])
        } else {
          const q = queryFrom(pos, flags)
          if (q.lat === undefined) throw new Error('usage: residentalerts chat <lat> <lon>')
          posts = await client.chat(q.lat, q.lon!)
        }
        if (flags.json) return json(posts), 0
        out(posts.length ? posts.map((p) => `${when(p.created_at).padStart(3)}  ${p.name}: ${p.text}${p.media.length ? `  [${p.media.length} ${p.media[0]!.kind}${p.media.length > 1 ? 's' : ''}] ${client.base}${p.media[0]!.url}` : ''}`).join('\n') : 'Nothing yet.')
        return 0
      }
      case 'watch':
      case 'tui': {
        const { runTui } = await import('./tui.js')
        await runTui(client, queryFrom(pos, flags))
        return 0
      }
      case 'mcp': {
        const { runMcp } = await import('./mcp.js')
        await runMcp(client)
        return 0
      }
      case 'serve': {
        const { serve } = await import('./server.js')
        const s = await serve()
        out(`resident.alerts ${VERSION} on http://${s.hostname}:${s.port}`)
        await new Promise(() => {})
        return 0
      }
      default:
        out(HELP)
        return 1
    }
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e))
    return 1
  }
}
