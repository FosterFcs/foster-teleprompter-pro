/* Foster Studio — service worker
   - Páginas: busca na rede primeiro (sempre a versão mais nova); sem internet, usa a cópia guardada.
   - Ícones e manifesto: cópia guardada primeiro.
   - API, webhook e qualquer coisa que não seja GET: nunca passa pelo cache. */
const VERSION = 'fs-v1';
const SHELL = ['/', '/index.html', '/termos.html', '/manifest.webmanifest',
  '/icons/icon-192.png', '/icons/icon-512.png', '/icons/apple-touch-icon.png', '/favicon.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const req = e.request; const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin) return;
  if (url.pathname.startsWith('/api/') || url.pathname === '/webhook') return;

  if (req.mode === 'navigate') {
    e.respondWith(fetch(req).then(res => {
      const copy = res.clone(); caches.open(VERSION).then(c => c.put(url.pathname === '/' ? '/' : req, copy));
      return res;
    }).catch(() => caches.match(req).then(r => r || caches.match('/'))));
    return;
  }
  e.respondWith(caches.match(req).then(r => r || fetch(req).then(res => {
    if (res.ok) { const copy = res.clone(); caches.open(VERSION).then(c => c.put(req, copy)); }
    return res;
  })));
});
