'use strict';
const CACHE = 'gamevoice-access-v3';
const VOICE_CACHE = 'gamevoice-neural-lab-v1';
const HOME = new URL('./', self.registration.scope);
const LAB = new URL('../neural-lab/', HOME);
const RUNTIME = [
  'neural-speaker.mjs?v=0.6.5',
  'subtitle-filter.mjs?v=0.6.2',
  'ocr-text.mjs?v=0.6.4',
  'subtitle-evidence.mjs?v=0.6.4',
  'synthesis-worker.mjs?v=0.6.5'
].map(path => new URL('../dmitri-ocr/' + path, HOME).href);
const INDEX = new URL('index.html', HOME).href;
const OWNER = new URL('owner-test.html', HOME).href;
self.addEventListener('install', event => event.waitUntil((async () => {
  const cache = await caches.open(CACHE);
  await cache.addAll([INDEX, OWNER, ...RUNTIME].map(url => new Request(url, { cache: 'reload' })));
  await self.skipWaiting();
})()));
self.addEventListener('activate', event => event.waitUntil((async () => {
  const names = await caches.keys();
  await Promise.all(names.filter(name => /^gamevoice-access-v\d+$/.test(name) && name !== CACHE)
    .map(name => caches.delete(name)));
  await self.clients.claim();
})()));
self.addEventListener('fetch', event => {
  const request = event.request, url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== HOME.origin || request.cache === 'reload') return;
  if (url.pathname.startsWith(LAB.pathname)) {
    event.respondWith((async () => {
      const cache = await caches.open(VOICE_CACHE);
      return await cache.match(url.href) || fetch(request);
    })());
    return;
  }
  if (RUNTIME.includes(url.href)) {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE);
      return await cache.match(url.href) || fetch(request);
    })());
    return;
  }
  if (!url.pathname.startsWith(HOME.pathname) || url.pathname.endsWith('/service-worker.js')) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const isApp = url.pathname === HOME.pathname || url.pathname === new URL(INDEX).pathname;
    const isOwner = url.pathname === new URL(OWNER).pathname;
    if (request.mode === 'navigate') {
      try {
        const response = await fetch(request, { cache: 'no-store' });
        if (response.ok && response.headers.get('content-type')?.includes('text/html')) {
          if (isApp) event.waitUntil(cache.put(INDEX, response.clone()));
          return response;
        }
        if (!isApp && !isOwner) return response;
      } catch {}
      return await cache.match(isApp ? INDEX : url.href) || new Response('Откройте страницу с интернетом для первой загрузки.', { status: 503 });
    }
    return await cache.match(url.href) || fetch(request);
  })());
});
