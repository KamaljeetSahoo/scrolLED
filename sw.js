/* scrolLED service worker: precache the app shell so it launches offline, and
   pick up new versions in the background (the page offers a refresh). Bump
   VERSION whenever any precached file changes. */
const VERSION = 'v1.0.0';
const CACHE = `scrolled-${VERSION}`;
const SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './css/app.css',
  './js/app.js',
  './js/engine.js',
  './js/raster.js',
  './js/boot.js',
  './js/font5x8.js',
  './fonts/Anton.woff2',
  './fonts/Bungee.woff2',
  './fonts/Orbitron-Black.woff2',
  './fonts/AbrilFatface.woff2',
  './fonts/Pacifico.woff2',
  './icons/favicon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/maskable-512.png',
  './icons/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await cache.addAll(SHELL.map((u) => new Request(u, { cache: 'reload' })));
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k.startsWith('scrolled-') && k !== CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    // Navigations: serve the shell from cache first so the app opens instantly
    // and offline; refresh the copy in the background.
    if (req.mode === 'navigate') {
      const cached = await cache.match('./index.html');
      const network = fetch(req).then((res) => { if (res.ok) cache.put('./index.html', res.clone()); return res; }).catch(() => null);
      return cached || (await network) || new Response('Offline', { status: 503, headers: { 'Content-Type': 'text/plain' } });
    }
    const cached = await cache.match(req, { ignoreSearch: true });
    if (cached) {
      // stale-while-revalidate for anything we precached
      event.waitUntil(fetch(req).then((res) => { if (res.ok) return cache.put(req, res.clone()); }).catch(() => {}));
      return cached;
    }
    try {
      const res = await fetch(req);
      if (res.ok && (url.pathname.endsWith('.png') || url.pathname.endsWith('.woff2'))) cache.put(req, res.clone());
      return res;
    } catch (e) {
      return new Response('', { status: 504 });
    }
  })());
});
