// sw.js - 超輕量 App Shell 快取
const CACHE = 'roastpred-v1';
const APP_SHELL = [
  '/',
  '/index.html',
  '/manifest.json',
  // 視你的打包結果而定；Vite 會把資源指紋化。保守做法是啟用 runtime cache（如下）。
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      await cache.addAll(
        APP_SHELL.map((url) => new Request(url, { cache: 'reload' }))
      );
    })()
  );
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => k !== CACHE && caches.delete(k)));
    })()
  );
  self.clients.claim();
});

self.addEventListener('fetch', (e) => {
  const req = e.request;

  // 1) HTML：Network-first（離線回退 cache）
  if (req.mode === 'navigate') {
    e.respondWith(
      (async () => {
        try {
          const fresh = await fetch(req);
          const cache = await caches.open(CACHE);
          cache.put(req, fresh.clone());
          return fresh;
        } catch {
          const cache = await caches.open(CACHE);
          const match = await cache.match('/index.html');
          return match || new Response('Offline', { status: 503 });
        }
      })()
    );
    return;
  }

  // 2) 其他資源：Cache-first（有就用、沒有就抓並存）
  e.respondWith(
    (async () => {
      const cache = await caches.open(CACHE);
      const cached = await cache.match(req);
      if (cached) return cached;
      try {
        const fresh = await fetch(req);
        cache.put(req, fresh.clone());
        return fresh;
      } catch {
        return cached || Response.error();
      }
    })()
  );
});
