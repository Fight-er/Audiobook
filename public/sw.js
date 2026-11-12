/* 离线外壳缓存：界面本身可离线打开；音频数据在 IndexedDB 中，无需经过 SW */
const CACHE = 'audiobook-shell-v13';
const ASSETS = [
  '/',
  '/index.html',
  '/css/app.css',
  '/css/app.css?v=13',
  '/js/app.js',
  '/js/app.js?v=13',
  '/js/api.js',
  '/js/store.js',
  '/js/parser.js',
  '/js/player.js',
  '/js/generator.js',
  '/js/export.js',
  '/manifest.webmanifest',
  '/icon.svg',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((cache) => Promise.all(ASSETS.map((a) => cache.add(a).catch(() => {}))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// 网络优先、离线回退缓存：保证改动即时生效，同时断网可用
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET') return;
  if (url.pathname.startsWith('/api/') || url.pathname === '/__status') return;
  if (url.origin !== self.location.origin) return;

  event.respondWith((async () => {
    try {
      const res = await fetch(event.request, { cache: 'no-cache' });
      if (res && res.ok) {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(event.request, copy)).catch(() => {});
      }
      return res;
    } catch {
      const cache = await caches.open(CACHE);
      const cached = await cache.match(event.request, { ignoreSearch: true });
      if (cached) return cached;
      if (event.request.mode === 'navigate') {
        const shell = await cache.match('/index.html');
        if (shell) return shell;
      }
      return new Response('离线状态：该资源未缓存', { status: 503, headers: { 'content-type': 'text/plain; charset=utf-8' } });
    }
  })());
});
