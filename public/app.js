// resident.alerts in the browser: the live map, the list, radio, and push alerts
// for your places. Every page also gets local times, share buttons and the
// service worker. Your location never leaves this browser unless you save it
// as a place for alerts.
(() => {
  'use strict'
  const $ = (id) => document.getElementById(id)
  const KIND_ICON = { police: '🚓', fire: '🔥', medical: '🚑', traffic: '🚗', weather: '⛈️', quake: '🌎', hazard: '⚠️', other: '📍' }
  const KIND_LABEL = { police: 'Police', fire: 'Fire', medical: 'Medical', traffic: 'Traffic', weather: 'Weather', quake: 'Earthquake', hazard: 'Hazard', other: 'Other' }
  const ALL_KINDS = Object.keys(KIND_LABEL)
  const TILES = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png'
  const ATTRIBUTION = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
  const store = {
    get(k, d) { try { const v = localStorage.getItem('ra.' + k); return v === null ? d : JSON.parse(v) } catch { return d } },
    set(k, v) { try { localStorage.setItem('ra.' + k, JSON.stringify(v)) } catch {} },
  }
  const ago = (at) => {
    const s = Math.max(0, Math.round((Date.now() - at) / 1000))
    if (s < 60) return 'just now'
    if (s < 3600) return Math.round(s / 60) + ' min ago'
    if (s < 86400) return Math.round(s / 3600) + ' h ago'
    return Math.round(s / 86400) + ' d ago'
  }
  const toKm = (a, b) => {
    const r = (d) => (d * Math.PI) / 180
    const h = Math.sin(r(b[0] - a[0]) / 2) ** 2 + Math.cos(r(a[0])) * Math.cos(r(b[0])) * Math.sin(r(b[1] - a[1]) / 2) ** 2
    return 6371 * 2 * Math.asin(Math.min(1, Math.sqrt(h)))
  }
  const miles = (k) => (k < 0.16 ? 'nearby' : (k * 0.621371).toFixed(k < 16 ? 1 : 0) + ' mi')
  const getJSON = async (url, opts) => {
    const r = await fetch(url, opts)
    const body = await r.json().catch(() => ({}))
    if (!r.ok) throw new Error(body.error || 'HTTP ' + r.status)
    return body
  }

  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {})

  // ---- every page --------------------------------------------------------------
  for (const t of document.querySelectorAll('time[data-local]')) t.textContent = new Date(t.dateTime).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })
  for (const b of document.querySelectorAll('[data-share]')) {
    b.addEventListener('click', async () => {
      const url = b.dataset.share
      try {
        if (navigator.share) await navigator.share({ title: b.dataset.title, url })
        else { await navigator.clipboard.writeText(url); b.textContent = 'Link copied' }
      } catch {}
    })
  }
  const radioBtn = document.querySelector('[data-radio-locate]')
  if (radioBtn) {
    radioBtn.addEventListener('click', () => {
      radioBtn.disabled = true
      radioBtn.textContent = 'Finding you…'
      navigator.geolocation.getCurrentPosition(
        (p) => { location.href = `/radio?lat=${p.coords.latitude.toFixed(4)}&lon=${p.coords.longitude.toFixed(4)}` },
        () => { radioBtn.disabled = false; radioBtn.textContent = 'Location is blocked: allow it and try again' },
        { enableHighAccuracy: false, timeout: 10000, maximumAge: 300000 },
      )
    })
  }

  const pinIcon = (i, fresh) => L.divIcon({ className: '', html: `<div class="pin k-${i.kind} sev-${i.severity}${fresh ? ' fresh' : ''}"></div>`, iconSize: [24, 24], iconAnchor: [12, 12] })
  const baseMap = (el, opts) => {
    const map = L.map(el, Object.assign({ zoomControl: false, attributionControl: true, worldCopyJump: true }, opts))
    L.tileLayer(TILES, { maxZoom: 19, attribution: ATTRIBUTION, className: 'dark-tiles' }).addTo(map)
    return map
  }

  const mini = $('mini')
  if (mini) {
    addEventListener('load', () => {
      if (!window.L) return
      const at = [Number(mini.dataset.lat), Number(mini.dataset.lon)]
      const map = baseMap(mini, { center: at, zoom: 15, scrollWheelZoom: false })
      if (mini.dataset.shape) {
        const rings = JSON.parse(mini.dataset.shape)
        const poly = L.polygon(rings, { color: '#8e6cff', weight: 2, fillOpacity: 0.15 }).addTo(map)
        map.fitBounds(poly.getBounds(), { padding: [20, 20] })
      } else L.marker(at, { icon: pinIcon({ kind: mini.dataset.kind, severity: 3 }, true) }).addTo(map)
    })
  }

  const app = $('app')
  if (!app) return

  // ---- the map app -------------------------------------------------------------
  const params = new URLSearchParams(location.search)
  const view = store.get('view', null)
  const state = {
    me: null,
    hours: Number(store.get('hours', 6)),
    kinds: new Set(store.get('kinds', ALL_KINDS)),
    serious: store.get('serious', false),
    seen: new Set(),
    loaded: false,
    list: [],
    markers: new Map(),
    shapes: null,
    places: store.get('places', []),
    alertKinds: new Set(store.get('alertKinds', ALL_KINDS)),
    alertSev: Number(store.get('alertSev', 2)),
    tab: 'feed',
  }
  const feedEl = $('feed')
  const sheet = $('sheet')

  addEventListener('load', () => {
    if (!window.L) return
    const start = params.get('lat') ? [Number(params.get('lat')), Number(params.get('lon'))] : view ? view.c : [39.5, -98.35]
    const zoom = params.get('z') ? Number(params.get('z')) : view ? view.z : 4
    const map = baseMap('map', { center: start, zoom })
    L.control.zoom({ position: 'topright' }).addTo(map)
    state.map = map
    state.layer = L.layerGroup().addTo(map)
    state.shapes = L.layerGroup().addTo(map)
    state.placeLayer = L.layerGroup().addTo(map)
    let t = null
    map.on('moveend', () => {
      store.set('view', { c: [map.getCenter().lat, map.getCenter().lng], z: map.getZoom() })
      clearTimeout(t)
      t = setTimeout(load, 350)
      if (state.tab === 'radio') radioSoon()
    })
    map.on('click', () => hideDetail())
    drawPlaces()
    load()
    setInterval(() => document.visibilityState === 'visible' && load(), 60000)
    // Already allowed before? Centre on the visitor without asking again.
    if (!params.get('lat') && navigator.permissions) {
      navigator.permissions.query({ name: 'geolocation' }).then((p) => p.state === 'granted' && locate(!view)).catch(() => {})
    }
  })

  function locate(fly = true) {
    return new Promise((resolve) => {
      if (!navigator.geolocation) return resolve(null)
      navigator.geolocation.getCurrentPosition(
        (p) => {
          state.me = [p.coords.latitude, p.coords.longitude]
          $('locate').classList.add('on')
          if (state.meMarker) state.meMarker.setLatLng(state.me)
          else state.meMarker = L.marker(state.me, { icon: L.divIcon({ className: '', html: '<div class="pin me"></div>', iconSize: [16, 16], iconAnchor: [8, 8] }), interactive: false, zIndexOffset: 1000 }).addTo(state.map)
          if (fly) state.map.setView(state.me, Math.max(state.map.getZoom(), 13))
          resolve(state.me)
        },
        () => { $('hint').textContent = 'Location is blocked for this site. Move the map to any city instead.'; resolve(null) },
        { enableHighAccuracy: true, timeout: 12000, maximumAge: 60000 },
      )
    })
  }
  $('locate').addEventListener('click', () => locate(true))

  async function load() {
    const map = state.map
    if (!map) return
    const c = map.getCenter()
    const b = map.getBounds()
    const radius = Math.min(500, Math.max(0.5, toKm([c.lat, c.lng], [b.getNorth(), b.getEast()])))
    const q = new URLSearchParams({ lat: c.lat.toFixed(5), lon: c.lng.toFixed(5), km: radius.toFixed(1), hours: String(state.hours), kinds: [...state.kinds].join(','), min_severity: state.serious ? '3' : radius > 150 ? '2' : '1', limit: '600' })
    try {
      const data = await getJSON('/api/v1/incidents?' + q)
      render(data.incidents, radius)
    } catch (e) {
      $('count').textContent = 'Could not load: ' + e.message
    }
  }

  function render(list, radius) {
    const firstLoad = !state.loaded
    const fresh = new Set()
    for (const i of list) {
      if (!state.seen.has(i.id)) {
        if (!firstLoad) fresh.add(i.id)
        state.seen.add(i.id)
      }
    }
    state.loaded = true
    state.list = list
    // Markers: keep the ones still listed, add new ones.
    const keep = new Set(list.map((i) => i.id))
    for (const [id, m] of state.markers) if (!keep.has(id)) { state.layer.removeLayer(m); state.markers.delete(id) }
    state.shapes.clearLayers()
    for (const i of list) {
      if (i.shape) {
        L.polygon(i.shape, { color: '#8e6cff', weight: 1.5, fillOpacity: i.severity >= 3 ? 0.18 : 0.08, interactive: true }).on('click', (e) => { L.DomEvent.stop(e); showDetail(i) }).addTo(state.shapes)
        continue
      }
      const recent = Date.now() - i.at < 30 * 60000
      let m = state.markers.get(i.id)
      if (!m) {
        m = L.marker([i.lat, i.lon], { icon: pinIcon(i, recent), keyboard: false, riseOnHover: true, zIndexOffset: i.severity * 100 })
        m.on('click', (e) => { L.DomEvent.stop(e); showDetail(i) })
        m.addTo(state.layer)
        state.markers.set(i.id, m)
      }
    }
    const from = state.me || [state.map.getCenter().lat, state.map.getCenter().lng]
    feedEl.innerHTML = list.length
      ? list.slice(0, 300).map((i) => row(i, from, fresh.has(i.id))).join('')
      : `<li class="empty">Nothing reported here in the last ${state.hours === 1 ? 'hour' : state.hours === 168 ? 'week' : state.hours + ' hours'}.</li>`
    $('count').textContent = list.length + (list.length === 600 ? '+' : '') + ' incidents'
    $('hint').textContent = radius > 150 ? 'Zoomed out: showing notable and serious calls. Zoom in for everything.' : 'Calls come from the 911 feeds cities publish. Locations are approximate.'
    chime(list.filter((i) => fresh.has(i.id)))
  }

  function row(i, from, fresh) {
    const d = toKm(from, [i.lat, i.lon])
    return `<li class="inc k-${i.kind} sev-${i.severity}${fresh ? ' fresh' : ''}"><a href="/i/${encodeURIComponent(i.id)}" data-id="${esc(i.id)}">
<span class="ico" aria-hidden="true">${KIND_ICON[i.kind] || '📍'}</span>
<span class="what"><b>${esc(i.title)}</b><span>${esc(i.address || i.area)}</span></span>
<span class="when"><time>${ago(i.at)}</time><span>${i.shape ? 'area' : miles(d)}</span></span></a></li>`
  }

  feedEl.addEventListener('click', (e) => {
    const a = e.target.closest('a[data-id]')
    if (!a || e.metaKey || e.ctrlKey) return
    const i = state.list.find((x) => x.id === a.dataset.id)
    if (!i || !state.map) return
    e.preventDefault()
    if (i.shape) state.map.fitBounds(L.polygon(i.shape).getBounds(), { padding: [30, 30] })
    else state.map.setView([i.lat, i.lon], Math.max(state.map.getZoom(), 15))
    sheet.classList.remove('open')
    showDetail(i)
  })

  function showDetail(i) {
    const d = $('detail')
    const from = state.me
    d.innerHTML = `<button class="x" type="button" aria-label="Close">×</button>
<p class="kicker">${KIND_ICON[i.kind]} ${KIND_LABEL[i.kind]}${i.severity === 3 ? ' · <b style="color:var(--accent)">serious</b>' : ''} · ${ago(i.at)}${from && !i.shape ? ' · ' + miles(toKm(from, [i.lat, i.lon])) : ''}</p>
<h3>${esc(i.title)}</h3>
<p class="where">${esc(i.address || i.area)}</p>
${i.detail ? `<p class="muted" style="margin:.2rem 0 .6rem;font-size:.88rem">${esc(i.detail)}</p>` : ''}
<div class="row wrap"><a class="btn primary" href="/i/${encodeURIComponent(i.id)}">Details</a><a class="btn" href="/radio?lat=${i.lat}&lon=${i.lon}">📻 Radio</a><button type="button" class="btn ghost" data-share-now>Share</button></div>`
    d.hidden = false
    d.querySelector('.x').onclick = hideDetail
    d.querySelector('[data-share-now]').onclick = async (e) => {
      const url = location.origin + '/i/' + encodeURIComponent(i.id)
      try { if (navigator.share) await navigator.share({ title: i.title, url }); else { await navigator.clipboard.writeText(url); e.target.textContent = 'Link copied' } } catch {}
    }
  }
  function hideDetail() { $('detail').hidden = true }

  // A short two-tone chime for a new serious call near you, while the app is open.
  let audio = null
  function chime(list) {
    if (!state.me || document.visibilityState !== 'visible') return
    if (!list.some((i) => i.severity >= 3 && toKm(state.me, [i.lat, i.lon]) <= 3)) return
    try {
      audio = audio || new AudioContext()
      ;[880, 660].forEach((f, n) => {
        const o = audio.createOscillator(), g = audio.createGain()
        o.frequency.value = f
        g.gain.setValueAtTime(0.0001, audio.currentTime + n * 0.18)
        g.gain.exponentialRampToValueAtTime(0.2, audio.currentTime + n * 0.18 + 0.02)
        g.gain.exponentialRampToValueAtTime(0.0001, audio.currentTime + n * 0.18 + 0.16)
        o.connect(g).connect(audio.destination)
        o.start(audio.currentTime + n * 0.18)
        o.stop(audio.currentTime + n * 0.18 + 0.17)
      })
    } catch {}
  }

  // ---- filters, tabs, sheet ---------------------------------------------------------
  const syncChips = (el, set) => { for (const b of el.querySelectorAll('.chip')) { const on = set.has(b.dataset.kind); b.classList.toggle('on', on); b.setAttribute('aria-pressed', String(on)) } }
  syncChips($('kinds'), state.kinds)
  $('kinds').addEventListener('click', (e) => {
    const b = e.target.closest('.chip')
    if (!b) return
    const k = b.dataset.kind
    // A tap on a chip when all are on shows only that kind; tapping again adds/removes.
    if (state.kinds.size === ALL_KINDS.length) state.kinds = new Set([k, 'other'])
    else if (state.kinds.has(k)) state.kinds.delete(k)
    else state.kinds.add(k)
    if (![...state.kinds].some((x) => x !== 'other')) state.kinds = new Set(ALL_KINDS)
    store.set('kinds', [...state.kinds])
    syncChips($('kinds'), state.kinds)
    load()
  })
  $('hours').value = String(state.hours)
  $('hours').addEventListener('change', () => { state.hours = Number($('hours').value); store.set('hours', state.hours); load() })
  $('serious').checked = state.serious
  $('serious').addEventListener('change', () => { state.serious = $('serious').checked; store.set('serious', state.serious); load() })
  $('grab').addEventListener('click', () => sheet.classList.toggle('open'))
  for (const t of document.querySelectorAll('.tab')) {
    t.addEventListener('click', () => {
      state.tab = t.dataset.tab
      for (const x of document.querySelectorAll('.tab')) { x.classList.toggle('on', x === t); x.setAttribute('aria-selected', String(x === t)) }
      for (const p of document.querySelectorAll('.pane')) p.hidden = p.dataset.pane !== state.tab
      if (state.tab === 'radio') radio()
      if (state.tab === 'alerts') alertsInit()
    })
  }

  // ---- radio ------------------------------------------------------------------------
  let radioT = null
  let radioKey = ''
  const radioSoon = () => { clearTimeout(radioT); radioT = setTimeout(radio, 600) }
  async function radio() {
    const el = $('radio')
    const c = state.map ? state.map.getCenter() : null
    if (!c) return
    const key = c.lat.toFixed(2) + ',' + c.lng.toFixed(2)
    if (key === radioKey) return
    radioKey = key
    el.innerHTML = '<p class="hint">Finding scanner feeds for this county…</p>'
    try {
      const r = await getJSON(`/api/v1/radio?lat=${c.lat.toFixed(4)}&lon=${c.lng.toFixed(4)}`)
      const feeds = r.feeds.filter((f) => f.online).slice(0, 12)
      el.innerHTML = `<h3 style="margin:.4rem 0">${esc(r.county)}, ${esc(r.stateCode)}</h3>
${feeds.length ? `<ol class="feeds">${feeds.map((f) => `<li><a href="${esc(f.url)}" target="_blank" rel="noopener"><span class="live">● live</span><b>${esc(f.name)}</b><span class="muted">${esc(f.genre)} · ${f.listeners} listening</span></a></li>`).join('')}</ol>` : `<p class="hint">No live scanner feeds for ${esc(r.county)} right now.</p>`}
<p class="row wrap">${r.countyUrl ? `<a class="btn ghost" href="${esc(r.countyUrl)}" target="_blank" rel="noopener">All ${esc(r.county)} feeds</a>` : ''}<a class="btn ghost" href="${esc(r.browse)}" target="_blank" rel="noopener">All of ${esc(r.state)}</a></p>
<p class="hint">Feeds stream from Broadcastify's free player in a new tab. Move the map to hear another county.</p>`
    } catch (e) {
      radioKey = ''
      el.innerHTML = `<p class="hint">${esc(e.message === 'radio listings cover the US only' ? 'Radio listings cover the US only. Move the map to a US county.' : 'Could not load radio: ' + e.message)}</p>`
    }
  }

  // ---- alerts: places + push -------------------------------------------------------
  const push = { reg: null, sub: null }
  const unb64 = (v) => Uint8Array.from(atob(v.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (v.length % 4)) % 4)), (c) => c.charCodeAt(0))
  const status = (t) => { $('push-status').textContent = t }
  const subJSON = () => push.sub && push.sub.toJSON()

  function drawPlaces() {
    if (!state.placeLayer) return
    state.placeLayer.clearLayers()
    for (const p of state.places) L.circle([p.lat, p.lon], { radius: p.km * 1000, color: '#0a84ff', weight: 1, fillOpacity: 0.04, interactive: false }).addTo(state.placeLayer)
  }
  function renderPlaces() {
    const el = $('places')
    el.innerHTML = state.places.length
      ? state.places.map((p, n) => `<li><input type="text" value="${esc(p.name)}" data-n="${n}" data-f="name" aria-label="Place name" maxlength="40"><label><input class="km" type="number" min="0.2" max="80" step="0.1" value="${(p.km * 0.621371).toFixed(1)}" data-n="${n}" data-f="mi" aria-label="Radius in miles"> mi</label><button type="button" data-del="${n}" aria-label="Remove">×</button></li>`).join('')
      : '<li class="empty" style="display:block">No places yet. Add one below.</li>'
    drawPlaces()
  }
  function savePlaces() {
    store.set('places', state.places)
    renderPlaces()
    syncDevice()
  }
  let alertsReady = false
  async function alertsInit() {
    renderPlaces()
    if (alertsReady) return
    alertsReady = true
    syncChips($('alert-kinds'), state.alertKinds)
    $('alert-sev').value = String(state.alertSev)
    if (!app.dataset.push) { $('push-on').disabled = true; status('Push is not switched on for this server yet.'); return }
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
      $('push-on').disabled = true
      const ios = /iphone|ipad|ipod/i.test(navigator.userAgent)
      status(ios ? 'On iPhone and iPad: tap Share, then "Add to Home Screen", and open resident.alerts from there to turn alerts on.' : 'This browser cannot do push notifications.')
      return
    }
    push.reg = await navigator.serviceWorker.ready
    push.sub = await push.reg.pushManager.getSubscription()
    if (push.sub) {
      try {
        const r = await getJSON('/api/v1/devices/lookup', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ endpoint: push.sub.endpoint, auth: subJSON().keys.auth }) })
        if (r.device.places.length) { state.places = r.device.places; store.set('places', state.places); renderPlaces() }
        setOn(true)
      } catch { setOn(false) }
    }
  }
  function setOn(on) {
    $('push-on').textContent = on ? 'Alerts are on ✓' : 'Turn on alerts on this device'
    $('push-on').disabled = on
    $('push-test').hidden = !on
    $('push-off').hidden = !on
    if (on) status(`Watching ${state.places.length} place${state.places.length === 1 ? '' : 's'} on this device. Changes save by themselves.`)
  }
  let syncT = null
  function syncDevice() {
    if (!push.sub) return
    clearTimeout(syncT)
    syncT = setTimeout(async () => {
      if (!state.places.length) { status('Add a place to keep alerts on.'); return }
      try {
        await getJSON('/api/v1/devices', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ subscription: subJSON(), places: state.places, kinds: [...state.alertKinds], min_severity: state.alertSev }) })
        status('Saved.')
      } catch (e) { status('Could not save: ' + e.message) }
    }, 500)
  }
  const askPlaceName = (fallback) => (prompt('Name this place (home, work, school…)', fallback) || fallback).slice(0, 40)
  $('add-here').addEventListener('click', async () => {
    status('Finding you…')
    const me = await locate(true)
    if (!me) return status('Location is blocked. Use "Add the map\'s center" instead.')
    state.places.push({ name: askPlaceName(state.places.length ? 'Place ' + (state.places.length + 1) : 'Home'), lat: +me[0].toFixed(5), lon: +me[1].toFixed(5), km: 1.6 })
    status('')
    savePlaces()
  })
  $('add-center').addEventListener('click', () => {
    const c = state.map.getCenter()
    state.places.push({ name: askPlaceName('Place ' + (state.places.length + 1)), lat: +c.lat.toFixed(5), lon: +c.lng.toFixed(5), km: 1.6 })
    savePlaces()
  })
  $('places').addEventListener('change', (e) => {
    const n = Number(e.target.dataset.n)
    if (!state.places[n]) return
    if (e.target.dataset.f === 'name') state.places[n].name = e.target.value.trim() || 'Place'
    if (e.target.dataset.f === 'mi') state.places[n].km = Math.min(80, Math.max(0.2, Number(e.target.value) / 0.621371))
    savePlaces()
  })
  $('places').addEventListener('click', (e) => {
    const n = e.target.dataset.del
    if (n === undefined) return
    state.places.splice(Number(n), 1)
    savePlaces()
  })
  $('alert-kinds').addEventListener('click', (e) => {
    const b = e.target.closest('.chip')
    if (!b) return
    const k = b.dataset.kind
    if (state.alertKinds.has(k)) state.alertKinds.delete(k)
    else state.alertKinds.add(k)
    if (!state.alertKinds.size) state.alertKinds = new Set(ALL_KINDS)
    store.set('alertKinds', [...state.alertKinds])
    syncChips($('alert-kinds'), state.alertKinds)
    syncDevice()
  })
  $('alert-sev').addEventListener('change', () => { state.alertSev = Number($('alert-sev').value); store.set('alertSev', state.alertSev); syncDevice() })
  $('push-on').addEventListener('click', async () => {
    try {
      if (!state.places.length) {
        status('Finding you, to add your first place…')
        const me = await locate(true)
        if (me) state.places.push({ name: 'Home', lat: +me[0].toFixed(5), lon: +me[1].toFixed(5), km: 1.6 })
        else return status('Add a place first: allow location, or use "Add the map\'s center".')
        store.set('places', state.places)
        renderPlaces()
      }
      if ((await Notification.requestPermission()) !== 'granted') return status('Notifications are blocked for this site. Allow them in your browser settings.')
      push.reg = push.reg || (await navigator.serviceWorker.ready)
      push.sub = (await push.reg.pushManager.getSubscription()) || (await push.reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: unb64(app.dataset.vapid) }))
      await getJSON('/api/v1/devices', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ subscription: subJSON(), places: state.places, kinds: [...state.alertKinds], min_severity: state.alertSev }) })
      setOn(true)
    } catch (e) { status(e.message || String(e)) }
  })
  $('push-test').addEventListener('click', async () => {
    try { await getJSON('/api/v1/devices/test', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ endpoint: push.sub.endpoint, auth: subJSON().keys.auth }) }); status('Sent. It should arrive in a few seconds.') } catch (e) { status(e.message) }
  })
  $('push-off').addEventListener('click', async () => {
    try {
      await getJSON('/api/v1/devices', { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ endpoint: push.sub.endpoint, auth: subJSON().keys.auth }) })
      await push.sub.unsubscribe()
      push.sub = null
      setOn(false)
      status('Alerts are off, and your places are deleted from our server. They stay saved in this browser.')
    } catch (e) { status(e.message) }
  })
})()
