// Service worker de Macrow: cachea la app para que abra offline
// y se instale como app de verdad (no solo un acceso directo).
const CACHE = 'macrow-v8';
const ASSETS = ['./macros.html', './manifest.json', './icon-192.png', './icon-512.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Cache-first con refresco en segundo plano: abre al instante,
// y si hay red, actualiza la copia guardada para la próxima vez.
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  // Noticias: siempre de la red; si no hay conexión, la última copia guardada.
  if (e.request.url.includes('noticias.json')) {
    const key = e.request.url.split('?')[0];
    e.respondWith(
      fetch(e.request).then((res) => {
        if (res && res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(key, copy)); }
        return res;
      }).catch(() => caches.match(key))
    );
    return;
  }
  e.respondWith(
    caches.match(e.request).then((cached) => {
      const network = fetch(e.request)
        .then((res) => {
          if (res && res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(e.request, copy));
          }
          return res;
        })
        .catch(() => cached);
      return cached || network;
    })
  );
});
