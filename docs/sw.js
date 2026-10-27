// Матч-центр: offline support. The page itself comes from the cache (refreshed in the background),
// data files go to the network first and fall back to the last copy.
const SHELL = 'matchcenter-shell-v1';
const DATA = 'matchcenter-data-v1';
const FILES = ['./', 'index.html', 'styles.css', 'app.js', 'manifest.webmanifest', 'icons/logo.png', 'icons/icon-192.png',
  'fonts/manrope-cyr.woff2', 'fonts/manrope-lat.woff2', 'fonts/unbounded-cyr.woff2', 'fonts/unbounded-lat.woff2'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => ![SHELL, DATA].includes(k)).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  if (url.hostname === 'raw.githubusercontent.com') {
    // Data: the ?v= minute stamp is dropped from the cache key so the last copy is found offline.
    const key = url.origin + url.pathname;
    e.respondWith(fetch(e.request).then((res) => {
      if (res.ok) { const copy = res.clone(); caches.open(DATA).then((c) => c.put(key, copy)); }
      return res;
    }).catch(() => caches.match(key).then((r) => r || Response.error())));
    return;
  }
  if (url.origin !== location.origin) return; // logos and news pictures: straight to the network
  e.respondWith(caches.match(e.request, { ignoreSearch: true }).then((cached) => {
    const net = fetch(e.request).then((res) => {
      if (res.ok) { const copy = res.clone(); caches.open(SHELL).then((c) => c.put(e.request, copy)); }
      return res;
    });
    return cached ? (net.catch(() => {}), cached) : net;
  }));
});
