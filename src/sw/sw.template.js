// Service worker (web build only). Generated into dist/sw.js by the
// `serviceWorker` plugin in vite.config.ts, which fills in VERSION and PRECACHE.
// - App shell + hashed assets are precached, so the app opens offline.
// - /uploads/* (immutable, random names) are cached on first view, keyed without their signature.
// - API and WebSocket traffic is never cached; note content is cached by the
//   editor in IndexedDB (y-indexeddb), and read-only data by src/lib/offlineCache.ts.
// - A new version waits until the page asks it to take over ("Reload" prompt).
const VERSION = '__VERSION__';
const PRECACHE = __PRECACHE__;
const SHELL = `shell-${VERSION}`;
const UPLOADS = 'uploads-v2'; // v2: keyed by plain path (links are signed now)

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

/**
 * Uploads are fetched with a signed, expiring query (shared/fileLinks.ts) but cached under the plain
 * path, so a file seen once still shows offline after its link expires. Only signed requests that the
 * server allowed are stored; the cache is cleared on sign-out (src/lib/offlineCache.ts).
 */
async function uploadFirst(request, url) {
  const cache = await caches.open(UPLOADS);
  const key = url.origin + url.pathname;
  const hit = await cache.match(key);
  if (hit) return hit;
  const res = await fetch(request);
  if (res.ok) cache.put(key, res.clone());
  return res;
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin) return;
  const p = url.pathname;
  if (p.startsWith('/api/') || p.startsWith('/collab/')) return;
  // OAuth for AI connectors: server redirects and JSON, never the cached shell (the consent page itself is an app page).
  if ((p.startsWith('/oauth/') && p !== '/oauth/consent') || p.startsWith('/.well-known/') || p === '/mcp') return;
  if (p.startsWith('/uploads/')) return e.respondWith(uploadFirst(req, url));
  if (req.mode === 'navigate') {
    // Network first so deploys show up; the cached shell when offline.
    return e.respondWith(fetch(req).catch(() => caches.match('/index.html', { cacheName: SHELL })));
  }
  e.respondWith(caches.match(req, { cacheName: SHELL }).then((hit) => hit ?? fetch(req)));
});
