'use strict';
const CACHE = 'gamevoice-voice-lab-v1';
const ROOT = new URL('./', self.registration.scope);
self.addEventListener('install', event => event.waitUntil(self.skipWaiting()));
self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter(name => name.startsWith('gamevoice-voice-lab-') && name !== CACHE)
      .map(name => caches.delete(name)));
    await self.clients.claim();
  })());
});
self.addEventListener('fetch', event => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== ROOT.origin || !url.pathname.startsWith(ROOT.pathname)) return;
  if (url.pathname.endsWith('/service-worker.js')) return;
  if (request.mode === 'navigate') {
    url.pathname = ROOT.pathname + 'index.html';
    url.search = '';
  }
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const saved = await cache.match(url.href);
    return saved || fetch(request);
  })());
});
