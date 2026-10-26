import { describe, expect, test } from 'bun:test'
import { houstonRows, mdy, unxml, withCross } from '../src/cities.js'
import { blockAddress, meet, streetName } from '../src/geocode.js'
import { classify, inShape, km, tidy, tidyAddress, toIncident, zoned } from '../src/sources.js'

describe('time', () => {
  test('wall-clock text in a zone becomes the right instant, both sides of DST', () => {
    expect(new Date(zoned('2026-10-25T19:16:00.000', 'America/Los_Angeles')).toISOString()).toBe('2026-10-26T02:16:00.000Z')
    expect(new Date(zoned('2026-01-15T08:00:00', 'America/New_York')).toISOString()).toBe('2026-01-15T13:00:00.000Z')
    expect(new Date(zoned('2026-11-01T12:00:00', 'America/Chicago')).toISOString()).toBe('2026-11-01T18:00:00.000Z')
    expect(Number.isNaN(zoned('garbage', 'UTC'))).toBe(true)
  })
  test('US dates with and without AM/PM', () => {
    expect(mdy('10/25/2026 9:02:22 PM')).toBe('2026-10-25T21:02:22')
    expect(mdy('10/25/2026 12:05:00 AM')).toBe('2026-10-25T00:05:00')
    expect(mdy('1/5/2026 22:22')).toBe('2026-01-05T22:22:00')
    expect(mdy('')).toBe('')
  })
  test('a timestamp that names its zone is parsed as is', () => {
    const src = { id: 's', area: 'X', homepage: '' }
    const i = toIncident(src, { ext: '1', type: 'Fire', address: '', time: '2026-10-26T02:23:48.000Z', lat: 30.2, lon: -97.7 }, 'America/Chicago', 0)
    expect(new Date(i!.at).toISOString()).toBe('2026-10-26T02:23:48.000Z')
    const rss = toIncident(src, { ext: '2', type: 'Fire', address: '', time: 'Sun, 25 Oct 2026 22:26:00 -0400', lat: 43, lon: -77 }, 'UTC', 0)
    expect(new Date(rss!.at).toISOString()).toBe('2026-10-26T02:26:00.000Z')
  })
})

describe('text', () => {
  test('shouting is tidied, mixed case is left alone', () => {
    expect(tidy('SUSPICIOUS PERSON / VEHICLE')).toBe('Suspicious person / vehicle')
    expect(tidy('Aid Response')).toBe('Aid Response')
    expect(tidyAddress('BEACH ST \\ GRANT AVE')).toBe('Beach St & Grant Ave')
    expect(tidyAddress('5200 BLOCK INTERNATIONAL DR')).toBe('5200 block International Dr')
    expect(tidyAddress('16TH ST \\ WIESE ST')).toBe('16th St & Wiese St')
    expect(unxml('MVA &amp; CHECK <![CDATA[x]]>')).toBe('MVA & CHECK x')
  })
  test('calls are sorted into kinds and severities', () => {
    expect(classify('SHOTS FIRED')).toEqual({ kind: 'police', severity: 3 })
    expect(classify('Fire in Building')).toEqual({ kind: 'fire', severity: 3 })
    expect(classify('Aid Response')).toEqual({ kind: 'medical', severity: 1 })
    expect(classify('MVA CHECK & ADVISE')).toEqual({ kind: 'traffic', severity: 2 })
    expect(classify('Tornado Warning')).toEqual({ kind: 'weather', severity: 3 })
    // "police" contains "ice", "items" contains "ems": neither may be weather or medical.
    expect(classify('POLICE SERVICE').kind).toBe('police')
    expect(classify('Found items', 'other').kind).toBe('other')
  })
})

describe('places', () => {
  test('distance and polygons', () => {
    expect(km(47.61, -122.33, 47.62, -122.33)).toBeCloseTo(1.11, 1)
    const square: [number, number][][] = [[[0, 0], [0, 10], [10, 10], [10, 0], [0, 0]]]
    expect(inShape(5, 5, square)).toBe(true)
    expect(inShape(15, 5, square)).toBe(false)
  })
  test('street names expand the way OpenStreetMap spells them', () => {
    expect(streetName('BLK W SAM HOUSTON PKWY S')).toBe('West Sam Houston Parkway South')
    expect(streetName('H MARK CROSSWELL JR ST')).toBe('H Mark Crosswell Jr Street')
    expect(streetName('SOUTHWEST FWY IB')).toBe('Southwest Freeway')
    expect(streetName('DEAD-END')).toBeNull()
    expect(streetName('40TH AVE')).toBe('40th Avenue')
    expect(blockAddress('5200 BLOCK INTERNATIONAL DR')).toBe('5200 International Drive')
    expect(blockAddress('W CHURCH ST')).toBeNull()
    expect(withCross('LOUISIANA ST', 'BLK HADLEY ST')).toBe('LOUISIANA ST / HADLEY ST')
    expect(withCross('MARNEL RD', 'DEAD-END')).toBe('MARNEL RD')
  })
  test('two crossing streets meet where they cross', () => {
    const ns: [number, number][][] = [[[29.70, -95.40], [29.80, -95.40]]]
    const ew: [number, number][][] = [[[29.75, -95.45], [29.75, -95.35]]]
    const p = meet(ns, ew)!
    expect(p.lat).toBeCloseTo(29.75, 4)
    expect(p.lon).toBeCloseTo(-95.4, 4)
    const far: [number, number][][] = [[[29.9, -95.45], [29.9, -95.35]]]
    expect(meet(ns, far)).toBeNull()
  })
})

describe('Houston table', () => {
  test('rows come out of the grid with a stable id', () => {
    const html = `<table id="GridView2"><tr><th>Agency</th></tr><tr><td>FD</td><td>LOUISIANA ST</td><td>BLK HADLEY ST</td><td>493P</td><td>10/25/2026 21:27</td><td>EMS EVENT</td><td>N</td></tr><tr><td>PD</td><td>MAIN ST</td><td>&nbsp;</td><td>1A</td><td>10/25/2026 21:20</td><td>CHECK PATIENT*</td><td>N</td></tr></table>`
    const rows = houstonRows(html)
    expect(rows).toHaveLength(2)
    expect(rows[0]!.address).toBe('LOUISIANA ST / HADLEY ST')
    expect(rows[0]!.time).toBe('2026-10-25T21:27:00')
    expect(rows[1]!.type).toBe('CHECK PATIENT')
    expect(rows[1]!.fallback).toBe('police')
    expect(houstonRows(html)[0]!.ext).toBe(rows[0]!.ext)
  })
})
