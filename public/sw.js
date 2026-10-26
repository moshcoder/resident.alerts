// resident.alerts service worker: installs the app, keeps the shell for offline
// use, and shows alerts. Incident data is live, so API calls are never cached.
const CACHE = 'ra-shell-v1'
const SHELL = ['/offline.html', '/style.css', '/app.js', '/favicon.svg', '/icon-192.png', '/manifest.webmanifest', '/vendor/leaflet.js', '/vendor/leaflet.css']

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()))
})

self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()))
})

self.addEventListener('fetch', (event) => {
  const req = event.request
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return
  if (req.mode === 'navigate') {
    event.respondWith(fetch(req).catch(() => caches.match('/offline.html')))
    return
  }
  const path = new URL(req.url).pathname
  if (SHELL.includes(path)) event.respondWith(fetch(req).catch(() => caches.match(path)))
})

self.addEventListener('push', (event) => {
  let data = {}
  try { data = event.data ? event.data.json() : {} } catch {}
  event.waitUntil(
    self.registration.showNotification(data.title || 'resident.alerts', {
      body: data.body || '',
      tag: data.tag || 'alert',
      renotify: Boolean(data.urgent),
      requireInteraction: Boolean(data.urgent),
      data: { url: data.url || '/' },
      icon: '/icon-192.png',
      badge: '/icon-192.png',
    }),
  )
})

self.addEventListener('notificationclick', (event) => {
  const url = (event.notification.data && event.notification.data.url) || '/'
  event.notification.close()
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((wins) => {
      const open = wins.find((w) => new URL(w.url).origin === self.location.origin)
      if (open) return open.navigate(url).then((w) => (w || open).focus())
      return self.clients.openWindow(url)
    }),
  )
})
