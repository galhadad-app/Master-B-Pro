const CACHE_NAME = 'business-pwa-clean-v10';

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;

  const url = new URL(event.request.url);

  // לא שומרים HTML / manifest / service worker ב-cache כדי שלא ייתקע לוגו ישן.
  if (
    url.pathname.endsWith('/index.html') ||
    url.pathname.endsWith('/manifest.json') ||
    url.pathname.endsWith('/service-worker.js') ||
    event.request.destination === 'document' ||
    event.request.destination === 'manifest'
  ) {
    event.respondWith(fetch(event.request, { cache: 'no-store' }));
    return;
  }

  event.respondWith(fetch(event.request).catch(() => caches.match(event.request)));
});
