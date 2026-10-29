/* App shell cache only: no hardware state, commands or measurements are cached. */
const CACHE = 'pnu-tes-v4-20261029-1';
const ASSETS = ['./', './index.html', './diag.html', './tacs_control.html', './app.js', './styles.css', './exp.html', './exp.js', './exp.css', './manifest.webmanifest', './icons/icon-192.png', './icons/icon-512.png', './icons/icon-maskable-512.png'];
self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(ASSETS)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', event => {
  event.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k.startsWith('pnu-tes-') && k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});
/* Network first so a new release shows up on the next open; cache when offline. */
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  const scope = new URL('./', self.location.href);
  if (event.request.method !== 'GET' || url.origin !== scope.origin || !url.pathname.startsWith(scope.pathname)) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    try {
      const res = await fetch(event.request);
      if (res.ok) cache.put(event.request, res.clone());
      return res;
    } catch (e) {
      const cached = await cache.match(event.request, { ignoreSearch: true });
      if (cached) return cached;
      if (event.request.mode === 'navigate') return cache.match('./index.html');
      throw e;
    }
  })());
});
