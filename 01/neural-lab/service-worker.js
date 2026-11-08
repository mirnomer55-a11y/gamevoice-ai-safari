'use strict';
const CACHE = 'gamevoice-neural-lab-v1';
const ROOT = new URL('./', self.registration.scope);
self.addEventListener('install', event => event.waitUntil(self.skipWaiting()));
self.addEventListener('activate', event => event.waitUntil((async () => {
  const names = await caches.keys();
  await Promise.all(names.filter(name => name.startsWith('gamevoice-neural-lab-') && name !== CACHE)
    .map(name => caches.delete(name)));
  await self.clients.claim();
})()));
self.addEventListener('fetch', event => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== ROOT.origin || !url.pathname.startsWith(ROOT.pathname)) return;
  if (url.pathname === ROOT.pathname + 'service-worker.js') return;
  if (request.cache === 'reload') return;
  const navigation = request.mode === 'navigate';
  if (navigation) {
    url.pathname = ROOT.pathname + 'index.html';
    url.search = '';
  }
  const key = url.href;
  const refresh = navigation || url.pathname === ROOT.pathname + 'manifest.json';
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    if (refresh) {
      try {
        const response = await fetch(request, { cache: 'no-store' });
        if (response.ok) return response;
      } catch {}
      const saved = await cache.match(key);
      if (saved) return saved;
      return new Response('Сначала откройте тест с интернетом и подготовьте голос.', {
        status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' }
      });
    }
    const saved = await cache.match(key);
    return saved || fetch(request);
  })());
});
