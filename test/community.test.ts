import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SOURCES } from '../src/cities.js'
import { areaRoom, cleanName, cleanText, Community, geohash, scrubMp4, sniff } from '../src/community.js'
import { Store } from '../src/db.js'
import { newKey } from '../src/premium.js'
import type { Pusher } from '../src/push.js'
import { RadioFinder } from '../src/radio.js'
import { createApp } from '../src/server.js'
import { inc } from './store.test.js'

// Media dirs for the tests, removed afterwards (/tmp can be a small tmpfs).
const dirs: string[] = []
const scratch = (prefix: string) => (dirs.push(mkdtempSync(join(tmpdir(), prefix))), dirs[dirs.length - 1]!)
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })))

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70, 73, 70, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 0xff, 0xd9])
const box = (type: string, body: Uint8Array) => {
  const b = new Uint8Array(8 + body.length)
  new DataView(b.buffer).setUint32(0, b.length)
  b.set([...type].map((c) => c.charCodeAt(0)), 4)
  b.set(body, 8)
  return b
}
const cat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0))
  let o = 0
  for (const p of parts) out.set(p, o), (o += p.length)
  return out
}
const gps = new TextEncoder().encode('+37.2358-121.9624/')
const MP4 = cat(box('ftyp', new TextEncoder().encode('isom\0\0\0\0')), box('moov', cat(box('mvhd', new Uint8Array(12)), box('udta', box('©xyz', gps)))), box('mdat', new Uint8Array(32)))

describe('pieces', () => {
  test('geohash cells', () => {
    expect(geohash(57.64911, 10.40744, 11)).toBe('u4pruydqqvj')
    expect(areaRoom(37.2358, -121.9624)).toBe(areaRoom(37.25, -121.95))
    expect(areaRoom(37.2358, -121.9624)).not.toBe(areaRoom(40.7, -74))
  })
  test('files are judged by their bytes', () => {
    expect(sniff(JPEG)?.kind).toBe('photo')
    expect(sniff(MP4)).toEqual({ kind: 'video', mime: 'video/mp4', ext: 'mp4' })
    expect(sniff(new TextEncoder().encode('<html><script>'))).toBeNull()
  })
  test("a video's location box is blanked without moving anything", () => {
    const v = MP4.slice()
    expect(scrubMp4(v)).toBe(1)
    expect(v.length).toBe(MP4.length)
    expect(new TextDecoder().decode(v)).not.toContain('+37.2358')
    expect(new TextDecoder().decode(v)).toContain('free')
    expect(sniff(v)?.kind).toBe('video')
  })
  test('text and names', () => {
    expect(cleanText('  hi\u0000 there\n\n\n\nbye ')).toBe('hi there\n\nbye')
    expect(cleanText('x'.repeat(1001))).toHaveProperty('error')
    expect(cleanText('http://a http://b http://c')).toHaveProperty('error')
    expect(cleanName('Tony E.')).toBe('Tony E.')
    expect(cleanName('Los Gatos Police')).toBeNull()
    expect(cleanName('x')).toBeNull()
  })
})

function setup() {
  const store = new Store()
  const sent: string[] = []
  const pusher: Pusher = { enabled: true, publicKey: 'B', send: async (_d, m) => (sent.push(m.title), true) }
  const community = new Community(store.db, store, scratch('ra-media-'), { maxBytes: 10_000_000, adminKey: 'admin-secret' })
  const premium = { coinpay: null, chains: ['BTC'], cents: 499, comp: new Set<string>() }
  const app = createApp({ store, sources: SOURCES, pusher, radio: new RadioFinder(), premium, community })
  const req = (path: string, o: { method?: string; json?: unknown; token?: string; headers?: Record<string, string>; ip?: string; body?: BodyInit } = {}) =>
    app.request(path, {
      method: o.method ?? (o.json || o.body ? 'POST' : 'GET'),
      headers: { 'x-real-ip': o.ip ?? '1.2.3.4', ...(o.json ? { 'content-type': 'application/json' } : {}), ...(o.token ? { authorization: `Bearer ${o.token}` } : {}), ...(o.headers ?? {}) },
      ...(o.json ? { body: JSON.stringify(o.json) } : o.body ? { body: o.body } : {}),
    })
  const join_ = async (name?: string, ip?: string) => ((await (await req('/api/v1/residents', { json: { name }, ...(ip ? { ip } : {}) })).json()) as any)
  return { app, store, community, req, join: join_, sent }
}

describe('community api', () => {
  test('join, comment on an incident, chat in the area', async () => {
    const { req, join, store } = setup()
    store.upsertIncidents([inc({ id: 'seattle-fire:F9' })])
    const a = await join('Tony')
    expect(a.resident.name).toBe('Tony')
    expect((await req('/api/v1/incidents/seattle-fire:F9/comments', { json: { text: 'smoke from here' } })).status).toBe(401)
    const c = await req('/api/v1/incidents/seattle-fire:F9/comments', { json: { text: 'smoke from here' }, token: a.token })
    expect(c.status).toBe(201)
    const list = (await (await req('/api/v1/incidents/seattle-fire:F9/comments')).json()) as any
    expect(list.posts.map((p: any) => p.text)).toEqual(['smoke from here'])
    expect((await req('/api/v1/incidents/nope/comments', { json: { text: 'x' }, token: a.token })).status).toBe(404)
    await req('/api/v1/chat', { json: { lat: 37.2358, lon: -121.9624, text: 'anyone hear sirens on 17?' }, token: a.token })
    const nearby = (await (await req('/api/v1/chat?lat=37.25&lon=-121.95')).json()) as any
    expect(nearby.posts[0].text).toContain('sirens')
    const far = (await (await req('/api/v1/chat?lat=40.7&lon=-74')).json()) as any
    expect(far.posts).toHaveLength(0)
  })
  test('upload a photo, attach it, fetch it with a range', async () => {
    const { req, join } = setup()
    const a = await join()
    const form = new FormData()
    form.append('file', new File([JPEG], 'x.jpg', { type: 'image/jpeg' }))
    const up = (await (await req('/api/v1/media', { body: form, token: a.token })).json()) as any
    expect(up.kind).toBe('photo')
    const bad = new FormData()
    bad.append('file', new File(['<svg onload=alert(1)>'], 'x.svg', { type: 'image/svg+xml' }))
    expect((await req('/api/v1/media', { body: bad, token: a.token })).status).toBe(400)
    const post = (await (await req('/api/v1/chat', { json: { lat: 1, lon: 1, text: '', media: [up.id] }, token: a.token })).json()) as any
    expect(post.media[0].url).toBe(up.url)
    const f = await req(up.url)
    expect(f.headers.get('content-type')).toBe('image/jpeg')
    expect(f.headers.get('content-security-policy')).toContain('sandbox')
    const part = await req(up.url, { headers: { range: 'bytes=0-3' } })
    expect(part.status).toBe(206)
    expect(new Uint8Array(await part.arrayBuffer())).toEqual(JPEG.slice(0, 4))
    // Someone else's upload cannot be attached.
    const b = await join(undefined, '5.6.7.8')
    expect((await req('/api/v1/chat', { json: { lat: 1, lon: 1, text: 'x', media: [up.id] }, token: b.token })).status).toBe(400)
  })
  test('a resident report alerts once two neighbors confirm it', async () => {
    const { req, join, store, sent } = setup()
    const [a, b, c] = [await join('Ann', '10.0.0.1'), await join('Bob', '10.0.0.2'), await join('Cat', '10.0.0.3')]
    store.saveDevice({ endpoint: 'https://push.example/1', p256dh: 'p', auth: 'q' }, { places: [{ name: 'Home', lat: 37.23, lon: -121.97, km: 3 }], kinds: ['fire'], min_severity: 1 })
    const rr = await req("/api/v1/reports", { json: { kind: "fire", title: "Brush fire by the trail", lat: 37.232, lon: -121.968 }, token: a.token })
    const r = (await rr.json()) as any
    expect(r.id).toStartWith('community:')
    expect(store.incident(r.id)?.area).toBe('Resident report')
    expect((await req(`/api/v1/reports/${r.id}/confirm`, { method: 'POST', token: a.token })).status).toBe(400)
    expect(((await (await req(`/api/v1/reports/${r.id}/confirm`, { method: 'POST', token: b.token })).json()) as any).alerted).toBe(false)
    expect(sent).toHaveLength(0)
    expect(((await (await req(`/api/v1/reports/${r.id}/confirm`, { method: 'POST', token: c.token })).json()) as any).alerted).toBe(true)
    expect(sent[0]).toContain('resident report')
    const page = await (await req(`/i/${encodeURIComponent(r.id)}`)).text()
    expect(page).toContain('id="report-box"')
  })
  test('three flags hide a post; the admin key bans', async () => {
    const { req, join, community } = setup()
    const spammer = await join('Spam', '9.9.9.9')
    const p = (await (await req('/api/v1/chat', { json: { lat: 1, lon: 1, text: 'buy stuff' }, token: spammer.token, ip: '9.9.9.9' })).json()) as any
    for (const n of [1, 2, 3]) {
      const f = await join(`Flagger${n}`, `8.8.8.${n}`)
      await req('/api/v1/flag', { json: { target: `post:${p.id}` }, token: f.token, ip: `8.8.8.${n}` })
    }
    expect(((await (await req('/api/v1/chat?lat=1&lon=1')).json()) as any).posts).toHaveLength(0)
    expect((await req('/api/v1/admin/ban', { json: { resident_id: spammer.resident.id }, headers: { 'x-admin-key': 'wrong' } })).status).toBe(403)
    expect(((await (await req('/api/v1/admin/ban', { json: { resident_id: spammer.resident.id }, headers: { 'x-admin-key': 'admin-secret' } })).json()) as any).banned).toBe(true)
    // Banned: the token no longer works, and the network cannot make a new name.
    expect((await req('/api/v1/chat', { json: { lat: 1, lon: 1, text: 'again' }, token: spammer.token, ip: '9.9.9.9' })).status).toBe(401)
    expect((await req('/api/v1/residents', { json: {}, ip: '9.9.9.9' })).status).toBe(403)
    expect(community.stats().residents).toBe(4)
  })
  test('the disk cap removes the oldest files first', async () => {
    const store = new Store()
    const cm = new Community(store.db, store, scratch('ra-cap-'), { maxBytes: 60 })
    const { resident } = cm.newResident('X', '1.1.1.1')
    const first = (await cm.addMedia(resident.id, JPEG.slice())) as any
    await cm.addMedia(resident.id, JPEG.slice())
    await cm.addMedia(resident.id, JPEG.slice())
    expect(cm.media(first.id)).toBeNull()
    expect(cm.stats().media_bytes).toBeLessThanOrEqual(60)
    expect(newKey()).toStartWith('ra_')
  })
})
