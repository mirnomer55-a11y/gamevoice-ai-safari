'use strict';

const CACHE = 'gamevoice-safari-v7';
const INDEX = new URL('./index.html', self.registration.scope).href;

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);

    await cache.add(
      new Request(INDEX, { cache: 'reload' })
    );

    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();

    await Promise.all(
      keys
        .filter(key =>
          key.startsWith('gamevoice-safari-') &&
          key !== CACHE
        )
        .map(key => caches.delete(key))
    );

    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  const request = event.request;
  const url = new URL(request.url);
  const home = new URL('./', self.registration.scope);

  if (request.method !== 'GET') return;
  if (url.origin !== home.origin) return;
  if (request.mode !== 'navigate') return;

  if (
    url.pathname !== home.pathname &&
    url.pathname !== new URL(INDEX).pathname
  ) {
    return;
  }

  event.respondWith((async () => {
    try {
      const response = await fetch(request, { cache: 'no-cache' });

      if (
        response.ok &&
        response.headers.get('content-type')?.includes('text/html')
      ) {
        const copy = response.clone();

        event.waitUntil(
          caches.open(CACHE)
            .then(cache => cache.put(INDEX, copy))
            .catch(() => {})
        );
      }

      return response;
    } catch {
      const cache = await caches.open(CACHE);
      const saved = await cache.match(INDEX);

      return saved || new Response(
        'Откройте GameVoice AI при подключённом интернете.',
        {
          status: 503,
          headers: {
            'Content-Type': 'text/plain; charset=utf-8'
          }
        }
      );
    }
  })());
});
