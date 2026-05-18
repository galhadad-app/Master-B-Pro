const CACHE_NAME = 'ten-laavod-pwa-business-v1';

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;

  const reqUrl = new URL(event.request.url);

  // לא שומרים manifest קבוע, כדי שכל עסק יקבל manifest דינמי משלו מה-HTML.
  if (reqUrl.pathname.endsWith('/manifest.json')) {
    event.respondWith(fetch(event.request));
    return;
  }

  // ניווט: קודם רשת, ואם אין חיבור מחזירים את הדף האחרון שנשמר לפי ה-URL כולל business.
  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
          return response;
        })
        .catch(async () => {
          const cached = await caches.match(event.request);
          return cached || caches.match('./index.html') || Response.error();
        })
    );
    return;
  }

  // שאר הקבצים: Network first עם cache כגיבוי, בלי לערבב start_url בין עסקים.
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        if (response && response.ok && reqUrl.origin === self.location.origin) {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
        }
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});
