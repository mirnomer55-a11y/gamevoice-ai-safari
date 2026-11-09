'use strict';
const CACHE = 'gamevoice-access-v1';
const VOICE_CACHE = 'gamevoice-neural-lab-v1';
const HOME = new URL('./', self.registration.scope);
const LAB = new URL('../neural-lab/', HOME);
const NEURAL = new URL('../dmitri-ocr/neural-speaker.mjs', HOME).href;
const INDEX = new URL('index.html', HOME).href;
const OWNER = new URL('owner-test.html', HOME).href;
self.addEventListener('install', event => event.waitUntil((async () => {
  const cache = await caches.open(CACHE);
  await cache.addAll([new Request(INDEX,{cache:'reload'}), new Request(NEURAL,{cache:'reload'}), new Request(OWNER,{cache:'reload'})]);
  await self.skipWaiting();
})()));
self.addEventListener('activate', event => event.waitUntil((async () => {
  const names = await caches.keys();
  await Promise.all(names.filter(name => /^gamevoice-access-v\d+$/.test(name) && name !== CACHE).map(name => caches.delete(name)));
  await self.clients.claim();
})()));
self.addEventListener('fetch', event => {
  const request = event.request, url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== HOME.origin || request.cache === 'reload') return;
  if (url.pathname.startsWith(LAB.pathname)) {
    event.respondWith((async () => {
      const voice = await caches.open(VOICE_CACHE);
      return await voice.match(url.href) || fetch(request);
    })());
    return;
  }
  if (url.href === NEURAL) {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE);
      return await cache.match(NEURAL) || fetch(request);
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
        const response = await fetch(request,{cache:'no-store'});
        if (response.ok && response.headers.get('content-type')?.includes('text/html')) {
          if (isApp) event.waitUntil(cache.put(INDEX,response.clone()));
          return response;
        }
        // Never return the app for an unrelated 404 under this folder.
        if (!isApp && !isOwner) return response;
      } catch {}
      return await cache.match(isApp ? INDEX : url.href) || new Response('Откройте страницу с интернетом для первой загрузки.',{status:503});
    }
    return await cache.match(url.href) || fetch(request);
  })());
});
