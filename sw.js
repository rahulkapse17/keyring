/* ============================================================
   Keyring — service worker
   Makes the app fully offline-capable. Nothing is ever sent
   anywhere: every request is served from the local cache.
   Bump CACHE_VERSION whenever app files change.
   ============================================================ */

const CACHE_VERSION = 'keyring-v1';
const PRECACHE = [
  './',
  'index.html',
  'manifest.webmanifest',
  'assets/css/app.css',
  'assets/js/crypto.js',
  'assets/js/storage.js',
  'assets/js/pwa.js',
  'assets/js/app.js',
  'icons/icon.svg',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/maskable-512.png',
  'icons/apple-touch-icon.png',
];

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(CACHE_VERSION)
      .then(function (cache) { return cache.addAll(PRECACHE); })
      .then(function () { return self.skipWaiting(); })
      .catch(function (err) { console.warn('[keyring sw] precache failed', err); })
  );
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys()
      .then(function (keys) {
        return Promise.all(keys.map(function (key) {
          if (key !== CACHE_VERSION) return caches.delete(key);
          return null;
        }));
      })
      .then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (event) {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Navigations: network first, fall back to the cached shell (offline)
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then(function (response) {
          const copy = response.clone();
          caches.open(CACHE_VERSION).then(function (cache) { cache.put(request, copy); });
          return response;
        })
        .catch(function () {
          return caches.match(request).then(function (hit) {
            return hit || caches.match('index.html');
          });
        })
    );
    return;
  }

  // Static assets: cache first, refresh in the background
  event.respondWith(
    caches.match(request).then(function (hit) {
      if (hit) {
        fetch(request).then(function (response) {
          if (response && response.status === 200) {
            caches.open(CACHE_VERSION).then(function (cache) { cache.put(request, response); });
          }
        }).catch(function () { /* offline: cached copy is enough */ });
        return hit;
      }

      return fetch(request).then(function (response) {
        if (response && response.status === 200 && response.type === 'basic') {
          const copy = response.clone();
          caches.open(CACHE_VERSION).then(function (cache) { cache.put(request, copy); });
        }
        return response;
      }).catch(function () {
        return caches.match('index.html');
      });
    })
  );
});
