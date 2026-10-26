/**
 * Server-rendered pages. The map app is public/app.js on top of the home page;
 * every other page (an incident, coverage, radio, about) is plain HTML that
 * works without script and can be shared.
 */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import type { SourceState } from './db.js'
import { pitFooter } from './pit-footer.js'
import type { Radio } from './radio.js'
import { ringFooter } from './ring-footer.js'
import { RING_PLACEHOLDER } from './ring.js'
import type { Incident, Kind, Source } from './sources.js'
import { CHAIN_LABELS } from './premium.js'
import { VERSION } from './version.js'
import { distanceText } from './worker.js'

export const SITE = 'https://resident.alerts.pit.world'
export const REPO = 'https://github.com/moshcoder/resident.alerts'

const TRACKER = process.env.CRAWLPROOF_SITE ? `<script data-site="${process.env.CRAWLPROOF_SITE}" src="https://crawlproof.com/stats.js" async></script>` : ''

const asset = (name: string) => {
  const body = readFileSync(new URL(`../public/${name}`, import.meta.url))
  return `/${name}?v=${createHash('sha256').update(body).digest('hex').slice(0, 10)}`
}
const STYLE_URL = asset('style.css')
const SCRIPT_URL = asset('app.js')
const LEAFLET_CSS = asset('vendor/leaflet.css')
const LEAFLET_JS = asset('vendor/leaflet.js')

const ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }
export const esc = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, (c) => ESC[c]!)

export const KIND_LABEL: Record<Kind, string> = { police: 'Police', fire: 'Fire', medical: 'Medical', traffic: 'Traffic', weather: 'Weather', quake: 'Earthquake', hazard: 'Hazard', other: 'Other' }
export const KIND_ICON: Record<Kind, string> = { police: '🚓', fire: '🔥', medical: '🚑', traffic: '🚗', weather: '⛈️', quake: '🌎', hazard: '⚠️', other: '📍' }

export function ago(at: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - at) / 1000))
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.round(s / 60)} min ago`
  if (s < 86_400) return `${Math.round(s / 3600)} h ago`
  return `${Math.round(s / 86_400)} d ago`
}
const iso = (at: number) => new Date(at).toISOString()

const LOGO = `<svg class="mark" viewBox="0 0 32 32" aria-hidden="true"><circle cx="16" cy="18" r="4.5" fill="currentColor"/><path d="M8.5 25.5a10.6 10.6 0 0 1 0-15M23.5 10.5a10.6 10.6 0 0 1 0 15M4.6 29a16 16 0 0 1 0-22M27.4 7a16 16 0 0 1 0 22" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></svg>`

export type Ctx = { origin: string }
type LayoutOptions = { title: string; description: string; path: string; body: string; ctx: Ctx; noindex?: boolean; app?: boolean; map?: boolean; bodyClass?: string; jsonLd?: unknown }

function layout(o: LayoutOptions): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${esc(o.title)}</title>
<meta name="description" content="${esc(o.description)}">
<meta name="color-scheme" content="dark">
<meta name="theme-color" content="#0b0d10">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="apple-mobile-web-app-title" content="Alerts">
${o.noindex ? '<meta name="robots" content="noindex">' : `<link rel="canonical" href="${esc(SITE + o.path)}">`}
<meta property="og:type" content="website">
<meta property="og:site_name" content="resident.alerts">
<meta property="og:title" content="${esc(o.title)}">
<meta property="og:description" content="${esc(o.description)}">
<meta property="og:url" content="${esc(SITE + o.path)}">
<meta name="twitter:card" content="summary">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="/icon-192.png">
<link rel="manifest" href="/manifest.webmanifest">
${o.map ? `<link rel="stylesheet" href="${LEAFLET_CSS}">` : ''}
<link rel="stylesheet" href="${STYLE_URL}">
${o.map ? `<script src="${LEAFLET_JS}" defer></script>` : ''}
<script src="${SCRIPT_URL}" defer></script>
${o.jsonLd ? `<script type="application/ld+json">${JSON.stringify(o.jsonLd).replace(/</g, '\\u003c')}</script>` : ''}
${TRACKER}
</head>
<body class="${esc(o.bodyClass ?? '')}">
${RING_PLACEHOLDER}
<header class="top">
  <a class="brand" href="/">${LOGO}<span>resident<b>.</b>alerts</span></a>
  <nav aria-label="Site">
    <a href="/">Map</a>
    <a href="/radio">Radio</a>
    <a href="/premium">Premium</a>
    <a href="/coverage">Coverage</a>
    <a href="/about">About</a>
  </nav>
</header>
${o.app ? o.body.replace('<!--footers-->', `<div class="appfoot">${ringFooter()}${pitFooter()}</div>`) : `<main class="page">\n${o.body}\n</main>\n${ringFooter()}\n${pitFooter()}`}
</body>
</html>`
}

const kindChips = (on: string) =>
  (['police', 'fire', 'medical', 'traffic', 'weather', 'quake', 'hazard'] as Kind[])
    .map((k) => `<button type="button" class="chip k-${k}${on.includes(k) ? ' on' : ''}" data-kind="${k}" aria-pressed="${on.includes(k)}">${KIND_ICON[k]} ${KIND_LABEL[k]}</button>`)
    .join('')

export function incidentRow(i: Incident & { distance_km?: number | null }, now = Date.now()): string {
  return `<li class="inc k-${i.kind} sev-${i.severity}"><a href="/i/${encodeURIComponent(i.id)}">
  <span class="ico" aria-hidden="true">${KIND_ICON[i.kind]}</span>
  <span class="what"><b>${esc(i.title)}</b><span>${esc(i.address || i.area)}</span></span>
  <span class="when"><time datetime="${iso(i.at)}">${ago(i.at, now)}</time>${i.distance_km != null ? `<span>${distanceText(i.distance_km)}</span>` : ''}</span>
</a></li>`
}

/** The map app. Without script it is still a list of the latest serious incidents. */
export function homePage(ctx: Ctx, o: { latest: Incident[]; push: boolean; vapid: string; sources: number; price: string }): string {
  const body = `<div class="app" id="app" data-vapid="${esc(o.vapid)}" data-push="${o.push ? '1' : ''}" data-price="${esc(o.price)}">
  <div id="map" class="map" role="region" aria-label="Map of incidents"></div>
  <div class="maptools">
    <button type="button" id="locate" class="fab" title="Center on me" aria-label="Center on me">◎</button>
  </div>
  <section class="sheet" id="sheet" aria-label="Incidents">
    <button type="button" class="grab" id="grab" aria-label="Expand or collapse the list"><span></span></button>
    <div class="tabs" role="tablist">
      <button role="tab" class="tab on" data-tab="feed" aria-selected="true">Nearby</button>
      <button role="tab" class="tab" data-tab="radio" aria-selected="false">📻 Radio</button>
      <button role="tab" class="tab" data-tab="alerts" aria-selected="false">🔔 Alerts</button>
    </div>
    <div class="pane" data-pane="feed">
      <div class="filters">
        <div class="chips" id="kinds">${kindChips('police fire medical traffic weather quake hazard')}</div>
        <div class="row">
          <label>Last <select id="hours"><option value="1">hour</option><option value="6" selected>6 hours</option><option value="24">24 hours</option><option value="168" data-premium>7 days ★</option><option value="720" data-premium>30 days ★</option></select></label>
          <label><input type="checkbox" id="serious"> Serious only</label>
          <span class="count" id="count"></span>
        </div>
      </div>
      <ol class="feed" id="feed">${o.latest.map((i) => incidentRow(i)).join('') || '<li class="empty">Nothing serious reported in the last day.</li>'}</ol>
      <p class="hint" id="hint">Showing the latest serious incidents in the ${o.sources} feeds we cover. Allow location, or move the map, to see what is near you.</p>
      <!--footers-->
    </div>
    <div class="pane" data-pane="radio" hidden>
      <div id="radio"><p class="hint">Police and fire radio for the area in the middle of the map.</p></div>
    </div>
    <div class="pane" data-pane="alerts" hidden>
      <div id="alerts">
        <p class="hint">Get a push the moment something happens near the places you care about: home, work, school, your parents' place. No account, no email, no phone number.</p>
        <p class="plan" id="plan">Free: 1 place within 3 miles. <a href="/premium">Premium</a>, ${esc(o.price)} once for life: up to 25 places, up to 50 miles each, and 30 days of history.</p>
        <ol class="places" id="places"></ol>
        <div class="row wrap">
          <button type="button" class="btn" id="add-here">+ Add where I am</button>
          <button type="button" class="btn ghost" id="add-center">+ Add the map's center</button>
        </div>
        <fieldset class="prefs"><legend>Alert me about</legend><div class="chips" id="alert-kinds">${kindChips('police fire medical traffic weather quake hazard')}</div>
          <label class="sev">Only <select id="alert-sev"><option value="1">everything</option><option value="2" selected>notable and serious</option><option value="3">serious only</option></select></label>
        </fieldset>
        <div class="row wrap">
          <button type="button" class="btn primary" id="push-on">Turn on alerts on this device</button>
          <button type="button" class="btn ghost" id="push-test" hidden>Send a test</button>
          <button type="button" class="btn ghost" id="push-off" hidden>Turn off</button>
        </div>
        <p class="status" id="push-status" role="status"></p>
        <details class="havekey"><summary>Have a Premium key?</summary><div class="row wrap"><input type="text" id="key-in" placeholder="ra_…" autocomplete="off" spellcheck="false" aria-label="Premium key"><button type="button" class="btn" id="key-use">Use it</button></div></details>
      </div>
    </div>
  </section>
  <aside class="detail" id="detail" hidden aria-live="polite"></aside>
  <noscript><style>.map,.maptools,.tabs,.filters{display:none}</style></noscript>
</div>`
  return layout({
    title: 'resident.alerts: live 911 incidents near you',
    description: 'A live map of police, fire, medical and traffic calls near you, from the 911 feeds cities publish, plus weather warnings, earthquakes and wildfires. Push alerts for the places you care about and the police radio for your county. Free; Premium is $4.99 once, for life.',
    path: '/',
    body,
    ctx,
    app: true,
    map: true,
    bodyClass: 'is-app',
    jsonLd: { '@context': 'https://schema.org', '@type': 'WebApplication', name: 'resident.alerts', url: SITE, applicationCategory: 'UtilitiesApplication', operatingSystem: 'Any', offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' } },
  })
}

export function incidentPage(ctx: Ctx, o: { i: Incident; nearby: (Incident & { distance_km: number | null })[]; source: Source | undefined }): string {
  const { i } = o
  const when = new Date(i.at)
  const body = `<article class="incident k-${i.kind} sev-${i.severity}">
  <p class="kicker">${KIND_ICON[i.kind]} ${KIND_LABEL[i.kind]}${i.severity === 3 ? ' · <b class="serious">serious</b>' : ''} · ${esc(i.area)}</p>
  <h1>${esc(i.title)}</h1>
  <p class="where">${esc(i.address)}</p>
  <p class="meta">Reported <time datetime="${iso(i.at)}" data-local>${esc(when.toUTCString().replace(' GMT', ' UTC'))}</time> (${ago(i.at)})${i.detail ? ` · ${esc(i.detail)}` : ''}</p>
  <div id="mini" class="mini" data-lat="${i.lat}" data-lon="${i.lon}" data-kind="${i.kind}" data-shape="${i.shape ? esc(JSON.stringify(i.shape)) : ''}"></div>
  <p class="row wrap">
    <a class="btn primary" href="/?lat=${i.lat}&amp;lon=${i.lon}&amp;z=15">Open on the map</a>
    <a class="btn" href="/radio?lat=${i.lat}&amp;lon=${i.lon}">📻 Police and fire radio here</a>
    <button type="button" class="btn ghost" data-share="${esc(SITE)}/i/${esc(encodeURIComponent(i.id))}" data-title="${esc(i.title)}">Share</button>
  </p>
  <p class="source">Source: <a href="${esc(i.url || o.source?.homepage || '#')}" rel="noopener" target="_blank">${esc(o.source?.name ?? i.source)}</a>. This is what the agency published; it is not confirmed by us, and the location of a dispatch is often a block or an intersection, not an exact address.</p>
</article>
${o.nearby.length ? `<section><h2>Also near here, last 24 hours</h2><ol class="feed">${o.nearby.map((n) => incidentRow(n)).join('')}</ol></section>` : ''}`
  return layout({
    title: `${i.title}: ${i.address || i.area} · resident.alerts`,
    description: `${KIND_LABEL[i.kind]} call reported ${when.toUTCString()} at ${i.address || i.area}${i.detail ? `. ${i.detail}` : ''}.`,
    path: `/i/${encodeURIComponent(i.id)}`,
    body,
    ctx,
    map: true,
    noindex: Date.now() - i.at > 7 * 86_400_000,
    jsonLd: { '@context': 'https://schema.org', '@type': 'Event', name: i.title, startDate: iso(i.at), eventStatus: 'https://schema.org/EventScheduled', location: { '@type': 'Place', name: i.address || i.area, geo: { '@type': 'GeoCoordinates', latitude: i.lat, longitude: i.lon } } },
  })
}

export function coveragePage(ctx: Ctx, o: { sources: Source[]; states: SourceState[]; counts: { source: string; kind: string; n: number }[]; devices: number }): string {
  const byId = new Map(o.states.map((s) => [s.id, s]))
  const total = (id: string) => o.counts.filter((c) => c.source === id).reduce((a, c) => a + c.n, 0)
  const rows = o.sources
    .map((s) => {
      const st = byId.get(s.id)
      const ok = st && st.last_ok && Date.now() - st.last_ok < Math.max(s.everyMs * 4, 20 * 60_000)
      return `<tr><td><span class="dot ${ok ? 'ok' : st?.last_error ? 'bad' : ''}" title="${ok ? 'reading' : esc(st?.last_error || 'not read yet')}"></span></td><td><a href="${esc(s.homepage)}" rel="noopener" target="_blank">${esc(s.name)}</a></td><td>${esc(s.area)}</td><td>${s.kinds.map((k) => KIND_ICON[k]).join(' ')}</td><td class="num">${total(s.id).toLocaleString('en-US')}</td><td>${st?.last_ok ? ago(st.last_ok) : '-'}</td></tr>`
    })
    .join('')
  const body = `<h1>Coverage</h1>
<p class="lede">Every incident on resident.alerts comes from a feed a city, county or federal agency publishes for anyone to read. We read each one every few minutes. Where an agency publishes only an address, we place it on the map ourselves (US Census and OpenStreetMap).</p>
<div class="tablewrap"><table class="table"><thead><tr><th></th><th>Feed</th><th>Area</th><th>Calls</th><th class="num">Last 24 h</th><th>Last read</th></tr></thead><tbody>${rows}</tbody></table></div>
<p>Weather warnings, earthquakes and wildfires cover the whole country. City 911 feeds cover the cities above, which are all the US cities we found that publish calls as they happen. Live in a city that publishes one we don't read? <a href="${REPO}/issues">Tell us</a> and we'll add it.</p>
<p class="muted">${o.devices.toLocaleString('en-US')} devices have alerts on.</p>`
  return layout({ title: 'Coverage · resident.alerts', description: 'The 911, fire, police, weather, earthquake and wildfire feeds resident.alerts reads, and how each one is doing right now.', path: '/coverage', body, ctx })
}

export function radioPage(ctx: Ctx, o: { lat?: number; lon?: number; radio?: Radio | null; error?: string }): string {
  const r = o.radio
  const list = r?.feeds.length
    ? `<ol class="feeds">${r.feeds
        .map((f) => `<li class="${f.online ? '' : 'off'}"><a href="${esc(f.url)}" rel="noopener" target="_blank"><span class="live">${f.online ? '● live' : 'offline'}</span><b>${esc(f.name)}</b><span class="muted">${esc(f.genre)} · ${f.listeners} listening</span></a></li>`)
        .join('')}</ol>`
    : ''
  const body = `<h1>📻 Police and fire radio</h1>
<p class="lede">Hear the dispatch channels for the county you are in. The audio is streamed by Broadcastify's volunteer scanner feeds; each one opens in their free player.</p>
${!o.lat ? `<p><button type="button" class="btn primary" data-radio-locate>Find radio near me</button></p><p class="muted">Or open it from any incident: every incident page has a radio button for that spot.</p>` : ''}
${o.error ? `<p class="error">${esc(o.error)}</p>` : ''}
${r ? `<h2>${esc(r.county)}, ${esc(r.stateCode)}</h2>${list || `<p>No scanner feeds are listed for ${esc(r.county)} yet.</p>`}<p class="row wrap">${r.countyUrl ? `<a class="btn ghost" href="${esc(r.countyUrl)}" rel="noopener" target="_blank">All feeds for ${esc(r.county)}</a>` : ''}<a class="btn ghost" href="${esc(r.browse)}" rel="noopener" target="_blank">Everything in ${esc(r.state)}</a></p>` : ''}
<h2>Why not the 911 calls themselves?</h2>
<p>Recordings of people calling 911 are not published live anywhere in the US: they are released, if at all, days later through records requests. What apps play as "911 audio" is the police and fire dispatch radio, which is what you hear here.</p>`
  return layout({ title: 'Police and fire radio near you · resident.alerts', description: 'Live police, fire and EMS scanner audio for your county.', path: '/radio', body, ctx })
}

export function aboutPage(ctx: Ctx, price: string): string {
  const body = `<h1>About resident.alerts</h1>
<p class="lede">A live map of what police, fire and paramedics are being sent to near you, with a push the moment something happens near the places you care about. Like the paid safety apps, for the price of a coffee once instead of a subscription, and without the tracking.</p>
<h2>Free</h2>
<ul class="ticks">
  <li>Live map and list of 911 incidents, weather warnings, earthquakes and wildfires, last 24 hours</li>
  <li>Push alerts for one place within 3 miles, each kind of call on or off, serious-only mode</li>
  <li>Police and fire radio for your county</li>
  <li>Shareable incident pages; an API, a command line, a terminal UI and an MCP server</li>
  <li>No ads. No account. No email or phone number. No selling your location</li>
</ul>
<h2>Premium: ${esc(price)} once, for life</h2>
<ul class="ticks">
  <li>Alerts for up to 25 places (home, work, school, family), each up to 50 miles</li>
  <li>7 and 30 days of history on the map and in the API</li>
  <li>Paid once in crypto through CoinPay. No subscription, nothing to cancel</li>
</ul>
<p><a class="btn primary" href="/premium">Get Premium</a></p>
<h2>How it works</h2>
<p>Cities and counties publish their dispatched calls as open data. We read those feeds every few minutes (see <a href="/coverage">coverage</a>), put each call on the map, and check it against the places devices asked about. Your places are stored with your device's push subscription and nothing else: no name, no account. Turn alerts off and they are deleted.</p>
<p>Your location stays in your browser. The map asks our server for incidents in the area on screen; it never sends where you are standing unless you add it as a place.</p>
<h2>What it is not</h2>
<p>Not an emergency service. If you need help, call 911. Dispatch data is preliminary: call types change, locations are often a block or an intersection, and some calls are withheld by the agency for privacy.</p>
<h2>Open source</h2>
<p>The code is MIT-licensed at <a href="${REPO}">${REPO.replace('https://', '')}</a>. resident.alerts is a Moshpit name; on the old internet it is <a href="${SITE}">${SITE.replace('https://', '')}</a>.</p>
<p><a class="btn ghost" href="/api">API, CLI and MCP</a></p>
<p class="muted">v${VERSION}</p>`
  return layout({ title: 'About · resident.alerts', description: 'What resident.alerts is, what it costs (nothing), and where its data comes from.', path: '/about', body, ctx })
}

export function apiPage(ctx: Ctx): string {
  const body = `<h1>API, CLI and MCP</h1>
<p class="lede">Everything on the map is open to scripts and agents. No key. Be kind: 120 requests a minute per address.</p>
<h2>HTTP</h2>
<pre><code>GET ${SITE}/api/v1/incidents?lat=47.61&amp;lon=-122.33&amp;km=5&amp;hours=6
GET ${SITE}/api/v1/incidents?kinds=police,fire&amp;min_severity=3&amp;hours=1
GET ${SITE}/api/v1/incidents/&lt;id&gt;
GET ${SITE}/api/v1/radio?lat=29.76&amp;lon=-95.37
GET ${SITE}/api/v1/sources</code></pre>
<p>Kinds: police, fire, medical, traffic, weather, quake, hazard, other. Severity 1 routine, 2 notable, 3 serious. Times are epoch milliseconds. Without a key, <code>hours</code> stops at 24; send <code>X-Premium-Key: ra_…</code> for up to 30 days.</p>
<h2>Command line and terminal UI</h2>
<pre><code>bunx @profullstack/residentalerts near 47.61 -122.33 --km 3
bunx @profullstack/residentalerts serious --hours 1
bunx @profullstack/residentalerts radio 29.76 -95.37
bunx @profullstack/residentalerts watch 47.61 -122.33   # live terminal view</code></pre>
<h2>MCP</h2>
<pre><code>claude mcp add residentalerts -- bunx @profullstack/residentalerts mcp</code></pre>
<p>Tools: <code>incidents_near</code>, <code>serious_incidents</code>, <code>get_incident</code>, <code>radio_near</code>, <code>coverage</code>.</p>`
  return layout({ title: 'API, CLI and MCP · resident.alerts', description: 'Open JSON API, command line, terminal UI and MCP server for live 911 incidents.', path: '/api', body, ctx })
}

export function premiumPage(ctx: Ctx, o: { chains: string[]; enabled: boolean; price: string; error?: string }): string {
  const body = `<h1>Premium</h1>
<p class="lede">${esc(o.price)} once. Yours for life: no subscription, no account, nothing to cancel.</p>
<ul class="ticks">
  <li>Alerts for up to <b>25 places</b> (free: 1)</li>
  <li>Each place up to <b>50 miles</b> across (free: 3 miles)</li>
  <li><b>7 and 30 days</b> of history on the map and in the API (free: 24 hours)</li>
</ul>
<p class="muted">The live map, the radio, every kind of call and serious-only alerts stay free for everyone.</p>
${o.error ? `<p class="error">${esc(o.error)}</p>` : ''}
${o.enabled
    ? `<form method="post" action="/premium" class="tipform">
  <label>Pay ${esc(o.price)} with <select name="chain">${o.chains.map((c) => `<option value="${esc(c)}">${esc(CHAIN_LABELS[c] ?? c)}</option>`).join('')}</select></label>
  <button class="btn primary">Get Premium for ${esc(o.price)}</button>
  <p class="muted">Payments by <a href="https://coinpayportal.com" rel="noopener">CoinPay</a>. When the payment confirms you get a Premium key: this browser keeps it, and you can paste it into any other device under Alerts.</p>
</form>`
    : '<p>Payments are not switched on yet.</p>'}`
  return layout({ title: 'Premium · resident.alerts', description: `resident.alerts Premium: alerts for 25 places, 50-mile radius, 30 days of history. ${o.price} once, for life.`, path: '/premium', body, ctx })
}

/** CoinPay's success page: the key, saved into this browser by app.js once the payment has settled. */
export function premiumKeyPage(ctx: Ctx, o: { key: string; paid: boolean; price: string }): string {
  const body = o.paid
    ? `<h1>Premium is on ★</h1>
<p class="lede">Thank you. This browser now has Premium. To use it on another device, paste this key under Alerts there:</p>
<p><code class="bigkey" id="premium-key" data-premium-key="${esc(o.key)}">${esc(o.key)}</code></p>
<p class="muted">Keep it somewhere safe: it is the only proof of purchase (we keep no account and no email). Anyone with the key gets Premium.</p>
<p><a class="btn primary" href="/">Back to the map</a></p>`
    : `<h1>Waiting for the payment…</h1>
<p class="lede">CoinPay has not confirmed your payment yet. Crypto can take a few minutes; this page checks again every 15 seconds.</p>
<p class="muted">Your key, for when it confirms: <code>${esc(o.key)}</code></p>
<meta http-equiv="refresh" content="15">`
  return layout({ title: 'Your Premium key · resident.alerts', description: 'Your resident.alerts Premium key.', path: '/premium', noindex: true, body, ctx })
}

export function messagePage(ctx: Ctx, o: { title: string; message: string; status?: number }): string {
  return layout({ title: `${o.title} · resident.alerts`, description: o.message, path: '/', noindex: true, body: `<h1>${esc(o.title)}</h1><p>${esc(o.message)}</p><p><a class="btn" href="/">Back to the map</a></p>`, ctx })
}
