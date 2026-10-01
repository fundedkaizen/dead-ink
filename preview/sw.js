// Dead Ink's offline cache: a second visit loads from the device instead of the network.
// Hashed build files (assets/*) never change, so they come from the cache first. Everything else (the page,
// the art, the maps' data, the music) is served from the cache at once and refreshed in the background, so
// a new deploy shows on the visit after. Bump VERSION to throw the whole cache away.
const VERSION = 'dead-ink-1'
self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k)))).then(() => self.clients.claim()))
})
self.addEventListener('fetch', event => {
  const request = event.request
  const url = new URL(request.url)
  if (request.method !== 'GET' || url.origin !== location.origin || request.headers.has('range')) return
  // The page itself: the network first (a new build's file names are in it), the cache when offline.
  if (request.mode === 'navigate') {
    event.respondWith(fetch(request).then(response => { const copy = response.clone(); caches.open(VERSION).then(c => c.put(request, copy)); return response }).catch(() => caches.match(request)))
    return
  }
  event.respondWith(caches.open(VERSION).then(async cache => {
    const cached = await cache.match(request)
    const fresh = fetch(request).then(response => { if (response.ok && response.status === 200) cache.put(request, response.clone()); return response }).catch(() => cached)
    if (cached && url.pathname.includes('/assets/')) return cached
    return cached ?? fresh
  }))
})
