/**
 * `residentalerts mcp`: resident.alerts for an agent, on stdio.
 *
 *   claude mcp add residentalerts -- bunx @profullstack/residentalerts mcp
 *
 * Keyless for reading what police, fire and EMS are being sent to, where. The
 * webhook tools manage your account's webhooks with RESIDENTALERTS_KEY (rak_…).
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { AlertsClient } from './client.js'
import { KINDS } from './sources.js'
import { VERSION } from './version.js'

const text = (value: unknown) => ({ content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] })
const failure = (error: unknown) => ({ isError: true, content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }] })
const wrap = <A>(fn: (a: A) => Promise<unknown>) => async (a: A) => {
  try {
    return text(await fn(a))
  } catch (e) {
    return failure(e)
  }
}
const kinds = z.array(z.enum(KINDS as [string, ...string[]])).optional()
/** Agents get a compact row; the full record is one get_incident away. */
const slim = (i: any) => ({ id: i.id, kind: i.kind, severity: i.severity, title: i.title, address: i.address, area: i.area, at: new Date(i.at).toISOString(), distance_km: i.distance_km, detail: i.detail || undefined })

export function createMcpServer(client = new AlertsClient()): McpServer {
  const server: any = new McpServer({ name: 'resident.alerts', version: VERSION })
  server.tool(
    'incidents_near',
    'Live 911 incidents (police, fire, medical, traffic), weather warnings, earthquakes and wildfires near a point, newest first. Severity 1 routine, 2 notable, 3 serious.',
    { lat: z.number().min(-90).max(90), lon: z.number().min(-180).max(180), km: z.number().min(0.1).max(500).optional(), hours: z.number().min(0.1).max(720).optional(), kinds, min_severity: z.number().int().min(1).max(3).optional(), limit: z.number().int().min(1).max(500).optional() },
    wrap(async (a: any) => (await client.incidents({ lat: a.lat, lon: a.lon, km: a.km ?? 3, hours: a.hours ?? 6, kinds: a.kinds, minSeverity: a.min_severity, limit: a.limit ?? 50 })).map(slim)),
  )
  server.tool(
    'serious_incidents',
    'Serious calls (shootings, structure fires, tornado warnings, big quakes) everywhere resident.alerts covers, in the last few hours.',
    { hours: z.number().min(0.1).max(72).optional(), limit: z.number().int().min(1).max(500).optional() },
    wrap(async (a: any) => (await client.incidents({ hours: a.hours ?? 2, minSeverity: 3, limit: a.limit ?? 50 })).map(slim)),
  )
  server.tool(
    'fires_near',
    'Wildfires the way Watch Duty shows them: active fires near a point (acres, containment, perimeter as rings of [lat, lon]), evacuation orders/warnings by zone, and red flag warnings. Omit lat/lon for the whole US.',
    { lat: z.number().min(-90).max(90).optional(), lon: z.number().min(-180).max(180).optional(), km: z.number().min(1).max(500).optional(), perimeters: z.boolean().optional() },
    wrap(async (a: any) => {
      const r = await client.fires(a.lat, a.lon, a.km ?? 150)
      const keep = (i: any) => ({ ...slim(i), ...(a.perimeters && i.shape ? { shape: i.shape } : {}) })
      return { fires: r.fires.map(keep), evacuations: r.evacuations.map(slim), warnings: r.warnings.map(slim) }
    }),
  )
  server.tool('fire_conditions', 'Wind (speed, gusts, direction it comes from), humidity and temperature from the nearest NWS station, and AQI from the nearest EPA AirNow monitor, at a point. fire_weather is true when it is dry and windy.', { lat: z.number(), lon: z.number() }, wrap(({ lat, lon }: any) => client.conditions(lat, lon)))
  server.tool('get_incident', 'One incident by id, with its source and a shareable page link.', { id: z.string().min(3).max(200) }, wrap(({ id }: any) => client.incident(id)))
  server.tool('radio_near', 'Police, fire and EMS scanner feeds for the US county at a point (Broadcastify links, live status, listeners).', { lat: z.number(), lon: z.number() }, wrap(({ lat, lon }: any) => client.radio(lat, lon)))
  server.tool('incident_comments', 'What residents said about an incident (text plus links to their photos and videos).', { id: z.string().min(3).max(200) }, wrap(({ id }: any) => client.comments(id)))
  server.tool('area_chat', 'Recent messages in the neighborhood chat for the ~40 km area around a point.', { lat: z.number(), lon: z.number() }, wrap(({ lat, lon }: any) => client.chat(lat, lon)))
  server.tool('list_webhooks', "Your account's webhook endpoints and the event types resident.alerts sends (needs RESIDENTALERTS_KEY, an API key from /account).", {}, wrap(() => client.webhooks()))
  server.tool(
    'create_webhook',
    'Have resident.alerts POST alerts for the places saved to your account (alert.issued, alert.updated, alert.ended) and premium.activated to a URL, as signed CloudEvents (Standard Webhooks). Returns the signing secret. events: patterns like "alert.*"; omit for all.',
    { url: z.string().url(), events: z.array(z.string()).optional(), description: z.string().max(200).optional() },
    wrap(({ url, events, description }: any) => client.addWebhook(url, events, description ?? '')),
  )
  server.tool('test_webhook', 'Send a webhook.test event to one of your endpoints now and say how it went.', { id: z.string() }, wrap(({ id }: any) => client.testWebhook(id)))
  server.tool('rotate_webhook_secret', "Replace an endpoint's signing secret; the old one stops working.", { id: z.string() }, wrap(({ id }: any) => client.rotateWebhook(id)))
  server.tool('delete_webhook', 'Remove a webhook endpoint.', { id: z.string() }, wrap(({ id }: any) => client.removeWebhook(id)))
  server.tool('webhook_deliveries', 'Recent webhook deliveries (status, attempts, payload), optionally for one endpoint.', { id: z.string().optional() }, wrap(({ id }: any) => client.webhookLog(id)))
  server.tool('coverage', 'Which feeds resident.alerts reads, whether each is healthy, and how many calls each had in the last 24 hours.', {}, wrap(() => client.sources()))
  return server
}

export async function runMcp(client = new AlertsClient()): Promise<void> {
  await createMcpServer(client).connect(new StdioServerTransport())
}
