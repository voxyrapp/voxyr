const CACHE_NAME = 'nexpro-v42';
const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/autonomo.html',
  '/gerente.html',
  '/admin.html',
  '/manifest.json',
  '/icon-192.png'
];

self.addEventListener('install', event => {
  self.skipWaiting();

  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);

    for (const asset of STATIC_ASSETS) {
      try {
        const response = await fetch(asset, { cache: 'no-store' });
        if (response && response.ok) {
          await cache.put(asset, response.clone());
        } else {
          console.warn('SW install: arquivo ignorado no cache inicial:', asset);
        }
      } catch (err) {
        console.warn('SW install: falha ao cachear:', asset, err);
      }
    }
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil(
    Promise.all([
      caches.keys().then(keys =>
        Promise.all(
          keys.map(key => {
            if (key !== CACHE_NAME) {
              return caches.delete(key);
            }
          })
        )
      ),
      self.clients.claim()
    ])
  );
});

self.addEventListener('fetch', event => {
  const req = event.request;
  const url = new URL(req.url);

  // HTML sempre tenta rede primeiro para não ficar preso em versão antiga
  if (req.mode === 'navigate' || req.destination === 'document') {
    event.respondWith(
      fetch(req)
        .then(response => {
          const copy = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(req, copy));
          return response;
        })
        .catch(() => caches.match(req).then(r => r || caches.match('/index.html')))
    );
    return;
  }

  // arquivos estáticos: cache first
  event.respondWith(
    caches.match(req).then(response => response || fetch(req))
  );
});

self.addEventListener('push', (event) => {
  let data = {};

  try {
    data = event.data ? event.data.json() : {};
  } catch (_) {
    data = {};
  }

  const title = data.title || 'Nexpro';
  const options = {
    body: data.body || 'Nova notificação',
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    tag: data.tag || 'default',
    data: {
      url: data.url || '/autonomo.html'
    }
  };

  event.waitUntil(
    self.registration.showNotification(title, options)
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  const url = event.notification.data?.url || 'https://nexprotecnologia.com/autonomo.html';

  event.waitUntil(
    (async () => {
      const clientList = await clients.matchAll({
        type: 'window',
        includeUncontrolled: true
      });

      for (const client of clientList) {
        try {
          await client.navigate(url);
          await client.focus();
          return;
        } catch (e) {
          console.warn('Falha ao navegar cliente existente:', e);
        }
      }

      if (clients.openWindow) {
        await clients.openWindow(url);
      }
    })()
  );
});