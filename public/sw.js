// Stellar Glass Desktop & Mobile Service Worker (Windows, macOS, iOS, Android)
// Network-first with offline app-shell fallback so updates deploy immediately
// while satisfying desktop PWA installability requirements in Chrome, Edge, and Safari.

const CACHE_NAME = 'stellar-glass-shell-v3';
// Clean URLs: firebase.json has "cleanUrls", so /index.html and /quote.html redirect to / and /quote,
// and a redirected response can't answer a page load. Cache the addresses pages are really served at.
const PRECACHE_URLS = [
  '/',
  '/quote',
  '/manifest.webmanifest',
  '/css/app.css',
  '/css/site.css',
  '/img/favicon.png',
  '/img/icon.png',
  '/img/icon-192.png',
  '/img/icon-512.png',
  '/img/icon-maskable-512.png',
  '/img/logo.png',
  '/img/logo-dark.png',
];

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE_URLS).catch(() => {})),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)),
      ),
    ).then(() => self.clients.claim()),
  );
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  // Only handle same-origin requests; never intercept Firebase/Google APIs
  if (url.origin !== self.location.origin) return;
  // Firebase Hosting's reserved /__/ addresses (the app's config, the sign-in helper pages) must reach
  // Firebase untouched: no caching and no offline fallback (Firebase's reserved-URL docs).
  if (url.pathname.startsWith('/__/')) return;
  // Never intercept range requests or large MP4 video streams
  if (request.headers.has('range') || url.pathname.endsWith('.mp4')) return;

  const revalidate = /\.(js|mjs|css|html|webmanifest)$/i.test(url.pathname) || request.mode === 'navigate';
  event.respondWith(
    fetch(request, revalidate ? { cache: 'no-cache' } : undefined)
      .then((networkResp) => {
        if (networkResp && networkResp.status === 200 && networkResp.type === 'basic' && !networkResp.redirected) {
          const copy = networkResp.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, copy)).catch(() => {});
        }
        return networkResp;
      })
      .catch(() =>
        caches.match(request).then((cached) => {
          if (cached && !cached.redirected) return cached;
          if (request.mode === 'navigate') {
            return caches.match(url.pathname.startsWith('/quote') ? '/quote' : '/')
              .then((page) => page || Response.error());
          }
          return Response.error();
        }),
      ),
  );
});
