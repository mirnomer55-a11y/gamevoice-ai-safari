'use strict';

const CACHE = 'gamevoice-safari-v4';
const APP_FILES = ['./', './index.html', './manifest.webmanifest'];
const INDEX_URL = new URL('./index.html', self.registration.scope).href;

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    const files = APP_FILES.map(path =>
      new Request(new URL(path, self.registration.scope), { cache: 'reload' })
    );
    await cache.addAll(files);
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(
      keys
        .filter(key => key.startsWith('gamevoice-safari-') && key !== CACHE)
        .map(key => caches.delete(key))
    );
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  const request = event.request;
  const url = new URL(request.url);

  if (request.method !== 'GET' || url.origin !== self.location.origin) return;
  if (!url.href.startsWith(self.registration.scope)) return;

  if (request.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const response = await fetch(request, { cache: 'no-cache' });
        if (!response.ok) return response;

        if (response.headers.get('content-type')?.includes('text/html')) {
          const cache = await caches.open(CACHE);
          await cache.put(INDEX_URL, response.clone());
        }
        return response;
      } catch {
        const cache = await caches.open(CACHE);
        return (await cache.match(INDEX_URL)) || Response.error();
      }
    })());
    return;
  }

  const appFile = APP_FILES.some(path =>
    new URL(path, self.registration.scope).href === url.href
  );
  if (!appFile) return;

  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    return (await cache.match(request)) || fetch(request);
  })());
});
