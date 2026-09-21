const CACHE = 'park-area-shell-v3';
const SHELL = ['./', './index.html', './styles.css', './app-icon.png', './manifest.webmanifest', './src/app.js', './src/geometry.js', './src/map-geometry.js', './src/kml.js', './src/storage.js', './src/area-worker.js', './vendor/leaflet/leaflet.js', './vendor/leaflet/leaflet.css'];
self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) if (key.startsWith('park-area-shell-') && key !== CACHE) await caches.delete(key);
    await self.clients.claim();
    for (const client of await self.clients.matchAll()) client.postMessage({type: 'shell-ready'});
  })());
});
self.addEventListener('message', event => {
  if (event.data?.type === 'check-shell') event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    if ((await Promise.all(SHELL.map(path => cache.match(path)))).every(Boolean)) event.source?.postMessage({type: 'shell-ready'});
  })());
});
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  // No background map, geocoder, or massive geometry cache: geometry lives in IndexedDB.
  if (event.request.method !== 'GET' || url.origin !== self.location.origin) return;
  const paths = SHELL.map(path => new URL(path, self.registration.scope).pathname);
  if (!paths.includes(url.pathname)) return;
  event.respondWith(caches.open(CACHE).then(async cache => (await cache.match(url.pathname)) || fetch(event.request)));
});
