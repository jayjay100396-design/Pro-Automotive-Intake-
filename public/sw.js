// Stellar Glass Desktop & Mobile Service Worker (Windows, macOS, iOS, Android)
// Network-first with offline app-shell fallback so updates deploy immediately
// while satisfying desktop PWA installability requirements in Chrome, Edge, and Safari.

const CACHE_NAME = 'stellar-glass-shell-v2';
const PRECACHE_URLS = [
  '/',
  '/index.html',
  '/quote.html',
  '/manifest.webmanifest',
  '/css/app.css',
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
  // Never intercept range requests or large MP4 video streams
  if (request.headers.has('range') || url.pathname.endsWith('.mp4')) return;

  event.respondWith(
    fetch(request)
      .then((networkResp) => {
        if (networkResp && networkResp.status === 200 && networkResp.type === 'basic') {
          const copy = networkResp.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, copy)).catch(() => {});
        }
        return networkResp;
      })
      .catch(() =>
        caches.match(request).then((cached) => {
          if (cached) return cached;
          if (request.mode === 'navigate') {
            return caches.match('/index.html');
          }
          return Response.error();
        }),
      ),
  );
});
