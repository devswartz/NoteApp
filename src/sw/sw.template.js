// Service worker (web build only). Generated into dist/sw.js by the
// `serviceWorker` plugin in vite.config.ts, which fills in VERSION and PRECACHE.
// - App shell + hashed assets are precached, so the app opens offline.
// - /uploads/* (immutable, random names) are cached on first view.
// - API and WebSocket traffic is never cached; note content is cached by the
//   editor in IndexedDB (y-indexeddb), and read-only data by src/lib/offlineCache.ts.
// - A new version waits until the page asks it to take over ("Reload" prompt).
const VERSION = '__VERSION__';
const PRECACHE = __PRECACHE__;
const SHELL = `shell-${VERSION}`;
const UPLOADS = 'uploads-v1';

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(PRECACHE)));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== SHELL && k !== UPLOADS).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('message', (e) => {
  if (e.data === 'skipWaiting') self.skipWaiting();
});

async function cacheFirst(cacheName, request) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(request);
  if (hit) return hit;
  const res = await fetch(request);
  if (res.ok) cache.put(request, res.clone());
  return res;
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin) return;
  const p = url.pathname;
  if (p.startsWith('/api/') || p.startsWith('/collab/')) return;
  if (p.startsWith('/uploads/')) return e.respondWith(cacheFirst(UPLOADS, req));
  if (req.mode === 'navigate') {
    // Network first so deploys show up; the cached shell when offline.
    return e.respondWith(fetch(req).catch(() => caches.match('/index.html', { cacheName: SHELL })));
  }
  e.respondWith(caches.match(req, { cacheName: SHELL }).then((hit) => hit ?? fetch(req)));
});
