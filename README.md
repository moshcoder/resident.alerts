# resident.alerts

Live 911 incidents near you on a map, push alerts for the places you care
about, and the police and fire radio for your county. No account, no ads.

**Free:** the live map and list (24 h), radio, every kind of call, push alerts
for 1 place within 3 miles. **Premium, $4.99 once for life** (CoinPay): up to 25
places, up to 50 miles each, 7 and 30 days of history. Premium is a key
(`ra_…`), made at checkout and valid once the payment settles; the browser keeps
it, and `X-Premium-Key` sends it to the API.

- Web / PWA: https://resident.alerts (Moshpit DNS) or https://resident.alerts.pit.world
- API: `GET /api/v1/incidents?lat=&lon=&km=&hours=&kinds=&min_severity=`, `/api/v1/incidents/:id`, `/api/v1/radio?lat=&lon=`, `/api/v1/sources`
- CLI + TUI: `bunx @profullstack/residentalerts near 47.61 -122.33`, `… watch 47.61 -122.33`
- MCP: `claude mcp add residentalerts -- bunx @profullstack/residentalerts mcp`

## Accounts

Email sign-in with a one-time link (no password): `/signin` -> link (hashed,
single use, 20 min, spent by a POST so mail scanners cannot) -> 180-day
session cookie (writes only count with `Sec-Fetch-Site: same-origin`). An
account holds Premium (bought while signed in, or a key attached on
`/account`), synced alert places and the community name. Buying Premium and
posting need an account; the map, radio and one alert place do not.
**Sign in with CoinPay** (OAuth 2.1 code + PKCE S256, client
`cp_14548d98fe01a7ca13c42dd0`, `COINPAY_OAUTH_CLIENT_ID/SECRET`): accounts link
by CoinPay `sub`, never by email (CoinPay emails are unverified). A new
CoinPay-only account keeps that email aside as unverified (not an admin, not on
the mailing list) until it is confirmed with a one-time link from `/account`;
confirming an email that already has an account merges the two. A signed-in
email account can connect CoinPay from `/account`.
`ADMIN_EMAILS` have Premium. Mail goes through Resend (`RESEND_API_KEY`,
`MAIL_FROM`); `GET /api/v1/admin/emails` (x-admin-key) exports the opt-in list
as CSV.

## Credit codes and invites

**Credit codes** ([`@profullstack/redeem-credits`](https://github.com/profullstack/redeem-credits)):
a code grants the unit `premium`; one with amount 1 is lifetime Premium, the
same thing $4.99 buys. A signed-in person redeems it under "Have a code?" on
`/account` (or `POST /api/v1/redeem {"code"}` with the session cookie). The
credit is applied the way a purchase is: a settled $0 row in `payments`
(chain `credit-code`) on the account, so Premium has one source of truth and
moves with the account on a merge. Someone who already has Premium is refused
before the code is spent. Mint one on the server (run the bin under bun; its
node shebang fails as root):

```sh
cd /opt/resident.alerts
bun $(readlink -f node_modules/.bin/redeem-credits) mint --db "$DATABASE_PATH" \
  --unit premium --amount 1 --label "for Dan" [--max 10] [--expires 30d]
bun $(readlink -f node_modules/.bin/redeem-credits) list   --db "$DATABASE_PATH"
bun $(readlink -f node_modules/.bin/redeem-credits) revoke <codeId> --db "$DATABASE_PATH"
```

A `grant --unit premium --amount 1 --user <account id>` works too: it switches
on the next time that person opens `/account`.

**Invites** ([`@profullstack/affiliates`](https://github.com/profullstack/affiliates)):
three single-use links per account at `/invites` (`GET/POST /api/v1/invites`).
A link lands on `/invite/<code>` (`/i/` is an incident page), rides in a 7-day
cookie, and is spent when that browser makes a **new** account (email link or
CoinPay). Premium is lifetime-only and there is nothing smaller to give, so an
invite gives neither person anything beyond the invite: we only remember who
brought whom. Every account also has an affiliate link (`/?ref=<code>`),
remembered first-touch for 30 days and credited to new accounts.

## Community

Residents (`rt_` token + name, tied to an account): comments on every
incident, an area chat per ~40 km geohash cell, residents' own reports
(unverified; push only after two other residents confirm), photos and videos.
Photos are re-encoded in the browser (EXIF/GPS gone), MP4/MOV `udta`/`meta`
boxes are blanked on the server, files are capped (10 MB photo, 25 MB video,
30/day, `MEDIA_MAX_GB` total, oldest first) and served sandboxed with ranges.
Three flags hide anything; `ADMIN_KEY` removes and bans (resident + network).

## Where the data comes from

Public feeds agencies publish themselves, read every few minutes on the server
(see `src/cities.ts` and `/coverage`):

| Feed | Area | Notes |
| --- | --- | --- |
| Seattle Fire real-time 911 | Seattle, WA | Socrata kzjm-xkqj |
| SFPD dispatched calls | San Francisco, CA | Socrata gnap-fj3t (~15 min behind) |
| Austin Fire + Austin traffic/police | Austin, TX | Socrata wpu4-x69d, dx9v-zd7x |
| Tulsa Fire dispatch | Tulsa, OK | JSON |
| Monroe County 911 | Rochester, NY | RSS with geo |
| Houston Fire + Police active incidents | Houston, TX | HTML table, geocoded |
| San Diego Fire-Rescue dispatch | San Diego, CA | JSON, geocoded |
| Orlando Police active calls | Orlando, FL | XML, geocoded |
| NWS warnings (with polygons) | US | api.weather.gov |
| USGS earthquakes M2.5+ | world | GeoJSON |
| Wildfires: NIFC WFIGS points + perimeters, CAL FIRE incidents | US | WFIGS ArcGIS (perimeters drawn, merged with CAL FIRE by name and distance) |
| Evacuation zones (orders, warnings, advisories) | US | Genasys Protect public WFS (`zonehavenv2:evacuation_zone`) |
| California Highway Patrol CAD | all of California | ASP.NET page, all 25 centers, Details postback for lat/lon |

Feeds without coordinates are placed by the US Census geocoder (block
addresses) or by intersecting the two streets' OpenStreetMap lines (Nominatim,
one request a second, every answer cached in SQLite).

**Radio:** point -> county (FCC Census Area API) -> Broadcastify's county page
-> live scanner feeds; ▶ opens Broadcastify's own mini player in a popup
(their player sends `frame-ancestors 'none'` and streams use per-listener
tokens, so it cannot play inside another site). Live 911 *caller*
recordings are not published anywhere in the US; what apps call "911 audio" is
dispatch radio. OpenMHz (trunked radio clips) blocks datacenter IPs and
cross-origin browser requests behind a Cloudflare challenge, so it can't be
embedded.

**Wildfire (Watch Duty-style):** fires, evacuation zones and NWS warnings are
*live* sources: each read is the agency's whole current list, so an incident
stays on the map for as long as it is listed (not just inside the hours window)
and ends when it drops off. A device can follow a fire
(`POST /api/v1/devices/follow`) and gets a push when its acres, containment or
status change and when it is out; a fire whose perimeter grows to within an
alert place's radius alerts that place once. The 🛰 button draws VIIRS
satellite hotspots (Esri Living Atlas layer fed by NASA FIRMS, no key; FIRMS'
own API needs one). Fires and evacuation zones show the wind, humidity and
temperature from the nearest NWS station and the AQI from the nearest EPA
AirNow monitor (hourly public files). Open-Meteo was skipped: its free tier is
non-commercial only.

**Map tiles:** OpenStreetMap's standard tiles, darkened with a CSS filter.

## Alerts

A device is its push subscription; places, kinds and minimum severity are
stored next to it and nothing else. Only incidents new to us and reported in
the last 30 minutes alert; a source's first read is silent; at most 20 pushes
per device per hour, most serious first.

## Run it

```sh
bun install
VAPID_PUBLIC_KEY=… VAPID_PRIVATE_KEY=… DATABASE_PATH=./ra.db bun src/server.ts   # :8806
bun test
```

Deploy (dev2): `ssh root@dev2 'cd /opt/resident.alerts && git pull && ./bin/install.sh'`.

MIT licensed.
