// resident.alerts community: comments on incidents, area chat, residents'
// reports, and photos/videos. A resident is a pseudonym this browser keeps
// (rt_… token + display name); nothing else identifies you.
(() => {
  'use strict'
  const $ = (id) => document.getElementById(id)
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
  const ls = {
    get(k, d) { try { const v = localStorage.getItem('ra.' + k); return v === null ? d : JSON.parse(v) } catch { return d } },
    set(k, v) { try { localStorage.setItem('ra.' + k, JSON.stringify(v)) } catch {} },
  }
  const ago = (at) => {
    const s = Math.max(0, Math.round((Date.now() - at) / 1000))
    if (s < 60) return 'now'
    if (s < 3600) return Math.round(s / 60) + 'm'
    if (s < 86400) return Math.round(s / 3600) + 'h'
    return Math.round(s / 86400) + 'd'
  }

  // ---- ▶ listen: Broadcastify's own mini player (their streams cannot play inside other sites) ----
  document.addEventListener('click', (e) => {
    const a = e.target.closest('[data-listen]')
    if (!a || e.metaKey || e.ctrlKey) return
    e.preventDefault()
    const w = window.open(`https://www.broadcastify.com/listen/feed/popout.php?feedId=${encodeURIComponent(a.dataset.listen)}`, 'ra-radio', 'popup,width=420,height=640')
    if (!w) location.href = a.href
    ls.set('lastFeed', { id: a.dataset.listen, name: a.dataset.name })
  })

  // ---- identity ----------------------------------------------------------------
  const token = () => ls.get('token', '')
  async function api(path, opts = {}) {
    const headers = Object.assign({}, opts.headers || {})
    if (token()) headers.authorization = 'Bearer ' + token()
    if (opts.json !== undefined) { headers['content-type'] = 'application/json'; opts.body = JSON.stringify(opts.json) }
    const r = await fetch('/api/v1' + path, { method: opts.method || 'GET', headers, body: opts.body })
    const body = await r.json().catch(() => ({}))
    if (r.status === 401 && token()) { ls.set('token', ''); ls.set('name', '') }
    if (!r.ok) throw Object.assign(new Error(body.error || 'HTTP ' + r.status), { status: r.status })
    return body
  }
  // Posting needs an account: signed out, we offer the sign-in page and come back here.
  async function ensureResident() {
    if (token()) return true
    const account = await fetch('/api/v1/account').then((r) => (r.ok ? r.json() : null)).catch(() => null)
    if (!account || !account.signed_in) {
      if (confirm('Sign in with your email to post, comment and share photos. It takes a minute: we email you a one-time link. Go to sign in?')) location.href = '/signin?next=' + encodeURIComponent(location.pathname + location.search)
      return false
    }
    const name = prompt('Pick a name neighbors will see (or leave it blank for "Neighbor 1234"):', ls.get('name', '') || '')
    if (name === null) return false
    try {
      const r = await api('/residents', { method: 'POST', json: { name: name.trim() } })
      ls.set('token', r.token)
      ls.set('name', r.resident.name)
      return true
    } catch (e) { alert(e.message); return false }
  }

  // ---- uploads -------------------------------------------------------------------
  // Photos are redrawn on a canvas before upload: that drops EXIF (and the GPS in it).
  async function prepare(file) {
    if (file.type.startsWith('video/')) {
      if (file.size > 25 * 1024 * 1024) throw new Error('Videos up to 25 MB (about 30 seconds).')
      return file
    }
    if (!file.type.startsWith('image/')) throw new Error('Photos or videos only.')
    if (file.type === 'image/gif') return file
    const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' })
    const scale = Math.min(1, 2048 / Math.max(bmp.width, bmp.height))
    const c = document.createElement('canvas')
    c.width = Math.round(bmp.width * scale)
    c.height = Math.round(bmp.height * scale)
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height)
    return new Promise((res, rej) => c.toBlob((b) => (b ? res(new File([b], 'photo.jpg', { type: 'image/jpeg' })) : rej(new Error('Could not read that photo.'))), 'image/jpeg', 0.85))
  }
  async function upload(file) {
    const f = await prepare(file)
    const form = new FormData()
    form.append('file', f)
    return api('/media', { method: 'POST', body: form })
  }

  // A text box with attach + send; `send(text, mediaIds)` does the posting.
  function composer(el, send, opts = {}) {
    if (!el) return null
    el.innerHTML = `${opts.noText ? '' : `<textarea rows="2" maxlength="1000" placeholder="${esc(opts.placeholder || 'Say something…')}" aria-label="Message"></textarea>`}
<div class="row wrap"><label class="btn ghost attach">📷 Photo or video<input type="file" accept="image/*,video/*" multiple hidden></label>${opts.noSend ? '' : '<button type="button" class="btn primary send">Send</button>'}<span class="muted small cstatus"></span></div>
<div class="thumbs"></div>`
    const ta = el.querySelector('textarea')
    const st = el.querySelector('.cstatus')
    const thumbs = el.querySelector('.thumbs')
    let media = []
    el.querySelector('input[type=file]').addEventListener('change', async (e) => {
      if (!(await ensureResident())) return
      for (const file of [...e.target.files].slice(0, 4 - media.length)) {
        st.textContent = 'Uploading…'
        try {
          const m = await upload(file)
          media.push(m)
          thumbs.insertAdjacentHTML('beforeend', m.kind === 'video' ? `<video src="${m.url}" muted playsinline preload="metadata"></video>` : `<img src="${m.url}" alt="">`)
          st.textContent = ''
        } catch (err) { st.textContent = err.message }
      }
      e.target.value = ''
    })
    const go = async () => {
      if (!(await ensureResident())) return
      const text = ta ? ta.value.trim() : ''
      if (!text && !media.length) return
      st.textContent = 'Sending…'
      try {
        await send(text, media.map((m) => m.id))
        if (ta) ta.value = ''
        media = []
        thumbs.innerHTML = ''
        st.textContent = ''
      } catch (err) { st.textContent = err.message }
    }
    el.querySelector('.send')?.addEventListener('click', go)
    ta?.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) go() })
    return { media: () => media.map((m) => m.id), reset: () => { media = []; thumbs.innerHTML = ''; if (ta) ta.value = '' } }
  }

  const linkify = (t) => esc(t).replace(/https?:\/\/[^\s<]+/g, (u) => `<a href="${u}" rel="nofollow ugc noopener" target="_blank">${u}</a>`).replace(/\n/g, '<br>')
  const mediaHtml = (list) => (list.length ? `<div class="pmedia">${list.map((m) => (m.kind === 'video' ? `<video src="${m.url}" controls playsinline preload="metadata"></video>` : `<a href="${m.url}" target="_blank"><img src="${m.url}" alt="" loading="lazy"></a>`)).join('')}</div>` : '')
  const postHtml = (p) => `<li class="post" data-id="${esc(p.id)}"><div class="phead"><b>${esc(p.name)}</b><time>${ago(p.created_at)}</time>
<span class="pact">${p.mine ? `<button type="button" data-del="${esc(p.id)}">delete</button>` : `<button type="button" data-flag="post:${esc(p.id)}">flag</button>`}</span></div>
${p.text ? `<div class="ptext">${linkify(p.text)}</div>` : ''}${mediaHtml(p.media)}</li>`

  // A live list of posts in one room, kept fresh by polling.
  function room(listEl, path, every = 10000) {
    let last = 0
    let timer = null
    let posts = []
    const draw = () => {
      listEl.innerHTML = posts.length ? posts.map(postHtml).join('') : '<li class="empty">Nothing yet. Be the first.</li>'
      if (listEl.dataset.scroll === 'bottom') listEl.scrollTop = listEl.scrollHeight
    }
    const pull = async (fresh) => {
      try {
        const r = await api(`${path()}${path().includes('?') ? '&' : '?'}after=${fresh ? 0 : last}`)
        if (fresh) posts = []
        for (const p of r.posts) if (!posts.some((x) => x.id === p.id)) posts.push(p)
        if (posts.length) last = posts[posts.length - 1].created_at
        draw()
        return r
      } catch (e) { if (fresh) listEl.innerHTML = `<li class="empty">${esc(e.message)}</li>` }
    }
    listEl.addEventListener('click', async (e) => {
      const del = e.target.dataset.del
      const flag = e.target.dataset.flag
      try {
        if (del && confirm('Delete this post?')) { await api('/posts/' + encodeURIComponent(del), { method: 'DELETE' }); posts = posts.filter((p) => p.id !== del); draw() }
        if (flag && (await ensureResident()) && confirm('Flag this as abusive, false or unsafe? Three flags hide it.')) { const r = await api('/flag', { method: 'POST', json: { target: flag } }); e.target.textContent = r.hidden ? 'hidden' : 'flagged'; e.target.disabled = true }
      } catch (err) { alert(err.message) }
    })
    return {
      start(freshPull = true) { clearInterval(timer); timer = setInterval(() => document.visibilityState === 'visible' && pull(false), every); return pull(freshPull) },
      stop() { clearInterval(timer); timer = null },
      add(p) { posts.push(p); last = p.created_at; draw() },
    }
  }

  // ---- incident page: comments + resident report box ---------------------------------
  const comments = $('comments')
  if (comments) {
    const id = comments.dataset.incident
    const r = room($('comment-posts'), () => `/incidents/${encodeURIComponent(id)}/comments`, 15000)
    r.start()
    composer($('comment-composer'), async (text, media) => r.add(await api(`/incidents/${encodeURIComponent(id)}/comments`, { method: 'POST', json: { text, media } })), { placeholder: 'What do you see? Add a photo or video.' })
  }
  const box = $('report-box')
  if (box) {
    const id = box.dataset.report
    const draw = async () => {
      try {
        const r = await api(`/reports/${encodeURIComponent(id)}`)
        const when = ago(r.created_at)
        box.innerHTML = `<p><b>Reported by ${esc(r.by)}</b> · ${when === 'now' ? 'just now' : when + ' ago'} · not confirmed by any agency</p>${mediaHtml(r.media)}
<p class="row wrap"><span class="muted">${r.confirms} neighbor${r.confirms === 1 ? '' : 's'} confirmed it${r.confirms >= 2 ? ' (nearby devices were alerted)' : ''}.</span>
${r.mine ? '' : `<button type="button" class="btn" id="rb-confirm"${r.confirmed ? ' disabled' : ''}>${r.confirmed ? 'You confirmed it' : 'I see it too'}</button><button type="button" class="btn ghost" id="rb-flag">Not true</button>`}</p>`
        $('rb-confirm')?.addEventListener('click', async () => { if (await ensureResident()) { try { await api(`/reports/${encodeURIComponent(id)}/confirm`, { method: 'POST' }); draw() } catch (e) { alert(e.message) } } })
        $('rb-flag')?.addEventListener('click', async () => { if ((await ensureResident()) && confirm('Flag this report as false? Three flags remove it.')) { try { const r2 = await api('/flag', { method: 'POST', json: { target: 'report:' + id } }); if (r2.hidden) location.href = '/'; else $('rb-flag').textContent = 'Flagged' } catch (e) { alert(e.message) } } })
      } catch (e) { box.innerHTML = `<p class="muted">${esc(e.message)}</p>` }
    }
    draw()
  }

  // ---- home: area chat ----------------------------------------------------------------
  const chatList = $('chat-posts')
  if (chatList) {
    chatList.dataset.scroll = 'bottom'
    let where = null
    let roomName = ''
    const chat = room(chatList, () => (roomName ? `/chat?room=${roomName}` : `/chat?lat=${where[0].toFixed(4)}&lon=${where[1].toFixed(4)}`), 8000)
    let open = false
    let movedT = null
    const enter = async () => {
      if (!window.raApp) return
      where = window.raApp.center()
      roomName = ''
      const r = await chat.start(true)
      if (r && r.room) roomName = r.room
      $('chat-room').textContent = 'Chat for this area'
      $('chat-who').textContent = ls.get('name', '') ? ' · you are ' + ls.get('name', '') : ''
    }
    composer($('chat-composer'), async (text, media) => {
      const c = window.raApp.center()
      chat.add(await api('/chat', { method: 'POST', json: roomName ? { room: roomName, text, media } : { lat: c[0], lon: c[1], text, media } }))
      $('chat-who').textContent = ' · you are ' + ls.get('name', '')
    }, { placeholder: 'Message your neighbors…' })
    window.raChat = {
      open() { open = true; enter() },
      close() { open = false; chat.stop() },
      // A new area only once the map has moved to another chat cell.
      moved() { clearTimeout(movedT); movedT = setTimeout(() => { if (open) enter() }, 800) },
    }
  }

  // ---- home: report what you see ----------------------------------------------------------
  const dlg = $('report-dlg')
  if (dlg) {
    let kind = 'police'
    let at = null
    const media = composer($('report-media'), async () => {}, { noText: true, noSend: true })
    const kinds = $('report-kinds')
    kinds.addEventListener('click', (e) => {
      const b = e.target.closest('.chip')
      if (!b) return
      kind = b.dataset.kind
      for (const x of kinds.querySelectorAll('.chip')) x.classList.toggle('on', x === b)
    })
    const close = () => { dlg.close(); $('crosshair').hidden = true }
    $('report-open').addEventListener('click', async () => {
      if (!(await ensureResident())) return
      at = null
      $('report-where').textContent = 'Location: the middle of the map (the ✛). Move the map to place it.'
      $('crosshair').hidden = false
      // Non-modal, so the map behind it can still be moved to place the pin.
      dlg.show()
    })
    $('report-cancel').addEventListener('click', close)
    $('report-here').addEventListener('click', async () => {
      const me = await window.raApp.locate({ fly: true })
      if (me) { at = me; $('report-where').textContent = 'Location: where you are now.' }
    })
    $('report-form').addEventListener('submit', async (e) => {
      e.preventDefault()
      const f = new FormData(e.target)
      const where = at || window.raApp.center()
      $('report-status').textContent = 'Posting…'
      try {
        const r = await api('/reports', { method: 'POST', json: { kind, title: f.get('title'), detail: f.get('detail'), lat: where[0], lon: where[1], media: media.media() } })
        e.target.reset()
        media.reset()
        $('report-status').textContent = ''
        close()
        window.raApp.reload()
        window.raApp.show(r)
      } catch (err) { $('report-status').textContent = err.message }
    })
  }
})()
