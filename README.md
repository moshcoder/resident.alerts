# resident.alerts

Live 911 incidents near you on a map, push alerts for the places you care
about, and the police and fire radio for your county. Every feature free: no
paid tier, no account, no ads.

- Web / PWA: https://resident.alerts (Moshpit DNS) or https://resident.alerts.pit.world
- API: `GET /api/v1/incidents?lat=&lon=&km=&hours=&kinds=&min_severity=`, `/api/v1/incidents/:id`, `/api/v1/radio?lat=&lon=`, `/api/v1/sources`
- CLI + TUI: `bunx @profullstack/residentalerts near 47.61 -122.33`, `… watch 47.61 -122.33`
- MCP: `claude mcp add residentalerts -- bunx @profullstack/residentalerts mcp`

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
| NIFC current wildfires | US | WFIGS ArcGIS |

Feeds without coordinates are placed by the US Census geocoder (block
addresses) or by intersecting the two streets' OpenStreetMap lines (Nominatim,
one request a second, every answer cached in SQLite).

**Radio:** point -> county (FCC Census Area API) -> Broadcastify's county page
-> live scanner feeds, opened in Broadcastify's own player. Live 911 *caller*
recordings are not published anywhere in the US; what apps call "911 audio" is
dispatch radio. OpenMHz (trunked radio clips) blocks datacenter IPs and
cross-origin browser requests behind a Cloudflare challenge, so it can't be
embedded.

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
