import { describe, expect, test } from 'bun:test'
import { closures, NIXLE_AGENCIES, nixleItems, paloAltoRows, pgeIncidents, ringCentre } from '../src/bayarea.js'
import { SOURCES } from '../src/cities.js'

describe('bay area sources', () => {
  test('registered once each', () => {
    for (const id of ['paloalto-police', 'pge-outages', 'caltrans-d4', 'nixle-scc', 'scc-sheriff']) expect(SOURCES.filter((s) => s.id === id).length).toBe(1)
  })

  test('Palo Alto: a call circle becomes its centre', () => {
    expect(ringCentre([[[-122, 37], [-122.2, 37], [-122.2, 37.2], [-122, 37.2]]])).toEqual([37.1, -122.1])
    const rows = paloAltoRows([{ attributes: { CALLTIME: 1793723045000, CALLTYPEDESCRIPTION: 'MUNI CODE VIOLATION', INCIDENTSTATUS: 'COMPLETED', CROSSSTREET: 'LANE 5 E/HAMILTON AVE', INCIDENTNUMBER: '202611030085' }, geometry: { rings: [[[-122.16, 37.44], [-122.17, 37.44], [-122.17, 37.45], [-122.16, 37.45]]] } }, { attributes: { INCIDENTNUMBER: 'x' }, geometry: {} }])
    expect(rows.length).toBe(1)
    expect(rows[0]).toMatchObject({ ext: '202611030085', address: 'LANE 5 E / HAMILTON AVE', time: 1793723045000, detail: 'Status: completed' })
  })

  test('PG&E: customers set the severity', () => {
    const src = { id: 'pge-outages', area: 'South Bay', homepage: 'h' }
    const [a, b] = pgeIncidents(src, [
      { attributes: { OUTAGE_ID: '1', OUTAGE_START: 1793719806000, EST_CUSTOMERS: 1, OUTAGE_CAUSE: 'PATROLLING', CREW_CURRENT_STATUS: 'T-Man On Site' }, geometry: { x: -122.038, y: 37.2996 } },
      { attributes: { OUTAGE_ID: '2', OUTAGE_START: 1793719806000, EST_CUSTOMERS: 2400 }, geometry: { x: -121.97, y: 37.23 } },
    ])
    expect(a).toMatchObject({ id: 'pge-outages:1', kind: 'hazard', severity: 1, title: 'Power outage: 1 customer' })
    expect(a!.detail).toContain('Cause: patrolling')
    expect(b).toMatchObject({ severity: 3, title: 'Power outage: 2,400 customers' })
  })

  test('Caltrans: only closures in effect now, in our counties', () => {
    const now = 1794030000000
    const row = (county: string, start: number, end: number, extra: any = {}) => ({ lcs: { index: `i${county}${start}`, location: { travelFlowDirection: 'North', begin: { beginCounty: county, beginRoute: 'SR-17', beginLocationName: 'A', beginNearbyPlace: 'Los Gatos', beginLatitude: '37.14', beginLongitude: '-121.98' }, end: { endLocationName: 'B' } }, closure: { typeOfClosure: 'Full', lanesClosed: 'All', typeOfWork: 'Paving', closureTimestamp: { closureStartEpoch: String(start / 1000), closureEndEpoch: String(end / 1000), isClosureEndIndefinite: 'false' }, ...extra } } })
    const list = closures({ id: 'caltrans-d4', homepage: 'h' }, [
      row('Santa Clara', now - 1000_000, now + 1000_000),
      row('Santa Clara', now + 1000_000, now + 2000_000), // not started
      row('Marin', now - 1000_000, now + 1000_000), // too far
      row('Santa Clara', now - 2000_000, now + 1000_000, { code1098: { isCode1098: 'true' } }), // picked up
    ], now)
    expect(list.length).toBe(1)
    expect(list[0]).toMatchObject({ title: 'SR-17 closed', severity: 2, address: 'A to B', area: 'Los Gatos, CA (Caltrans)' })
  })

  test('Nixle: items are pinned at the agency and kept a week', () => {
    const lg = NIXLE_AGENCIES[0]!
    const now = Date.parse('2026-11-03T17:00:00Z')
    const xml = `<rss><channel><item><title>Road closure on Blossom Hill Rd</title><link>https://local.nixle.com/alert/12687789/</link><pubDate>Mon, 02 Nov 2026 08:48:01 -0800</pubDate><description>&lt;p&gt;Expect delays&lt;/p&gt;</description></item><item><title>Old news</title><link>https://local.nixle.com/alert/1/</link><pubDate>Mon, 01 Sep 2026 08:48:01 -0700</pubDate><description>x</description></item></channel></rss>`
    const list = nixleItems({ id: 'nixle-scc' }, lg, xml, now - 7 * 86400_000)
    expect(list.length).toBe(1)
    expect(list[0]).toMatchObject({ id: 'nixle-scc:18939:12687789', kind: 'traffic', lat: lg.at[0], lon: lg.at[1], url: 'https://local.nixle.com/alert/12687789/' })
    expect(list[0]!.detail).toContain('Expect delays')
  })
})
