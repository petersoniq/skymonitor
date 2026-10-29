/* SkyMonitor service worker – offline app shell */
var SHELL_CACHE = 'skymonitor-shell-v1';
var TILE_CACHE = 'skymonitor-tiles-v1';
var SHELL = [
  './', './index.html', './js/app.js', './manifest.webmanifest',
  './icons/icon.svg',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js'
];

self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(SHELL_CACHE).then(function (c) { return c.addAll(SHELL); }).then(function () { return self.skipWaiting(); }));
});

self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k !== SHELL_CACHE && k !== TILE_CACHE; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});

self.addEventListener('fetch', function (e) {
  var url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;

  if (url.hostname === 'opensky-network.org') {
    // API: vždy čerstvé, pri zlyhaní offline fallback
    e.respondWith(fetch(e.request).catch(function () { return new Response('{"states":[]}', { headers: { 'Content-Type': 'application/json' } }); }));
    return;
  }
  if (url.hostname.endsWith('tile.openstreetmap.org')) {
    // dlaždice: cache-first (stale-while-revalidate)
    e.respondWith(caches.open(TILE_CACHE).then(function (c) {
      return c.match(e.request).then(function (hit) {
        var net = fetch(e.request).then(function (r) { c.put(e.request, r.clone()); return r; }).catch(function () { return hit; });
        return hit || net;
      });
    }));
    return;
  }
  // shell: cache-first s aktualizáciou na pozadí
  e.respondWith(caches.open(SHELL_CACHE).then(function (c) {
    return c.match(e.request).then(function (hit) {
      var net = fetch(e.request).then(function (r) { if (r.ok) c.put(e.request, r.clone()); return r; }).catch(function () { return hit; });
      return hit || net;
    });
  }));
});
