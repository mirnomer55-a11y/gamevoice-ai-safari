'use strict';
const CACHE = 'gamevoice-dmitri-ocr-v5';
const VOICE_CACHE = 'gamevoice-neural-lab-v1';
const HOME = new URL('./', self.registration.scope);
const LAB = new URL('../neural-lab/', HOME);
const INDEX = new URL('index.html', HOME).href;
self.addEventListener('install', event => event.waitUntil((async () => {
  const cache = await caches.open(CACHE);
  await cache.addAll([
    INDEX,
    new URL('neural-speaker.mjs?v=0.6.4', HOME).href,
    new URL('ocr-text.mjs?v=0.6.4', HOME).href,
    new URL('subtitle-evidence.mjs?v=0.6.4', HOME).href,
    new URL('subtitle-filter.mjs?v=0.6.2', HOME).href,
    new URL('synthesis-worker.mjs?v=0.6.1', HOME).href
  ].map(url => new Request(url, { cache: 'reload' })));
  await self.skipWaiting();
})()));
self.addEventListener('activate', event => event.waitUntil((async () => {
  const names = await caches.keys();
  await Promise.all(names.filter(name => name.startsWith('gamevoice-dmitri-ocr-') && name !== CACHE)
    .map(name => caches.delete(name)));
  await self.clients.claim();
})()));
self.addEventListener('fetch', event => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== HOME.origin || request.cache === 'reload') return;
  if (url.pathname.startsWith(LAB.pathname)) {
    // A dedicated Worker inherits the controlling document's SW. Explicitly
    // reuse the existing lab cache for the worker and every model asset.
    event.respondWith((async () => {
      const cache = await caches.open(VOICE_CACHE);
      return await cache.match(url.href) || fetch(request);
    })());
    return;
  }
  if (!url.pathname.startsWith(HOME.pathname) || url.pathname.endsWith('/service-worker.js')) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    if (request.mode === 'navigate') {
      try {
        const response = await fetch(request, { cache: 'no-store' });
        if (response.ok && response.headers.get('content-type')?.includes('text/html')) {
          event.waitUntil(cache.put(INDEX, response.clone()));
          return response;
        }
      } catch {}
      return await cache.match(INDEX) || new Response('Откройте тест с интернетом для первой подготовки.', { status: 503 });
    }
    return await cache.match(url.href) || fetch(request);
  })());
});



