/**
 * sw.js — offline support. Precaches every file the app needs, then serves
 * cache-first. Bump VERSION whenever any file changes so devices update.
 */
const VERSION = 'calm-space-v3';
const FILES = [
  './', './index.html', './manifest.webmanifest',
  './js/main.js', './js/input.js', './js/audio.js', './js/util.js',
  './js/scenes/discs.js', './js/scenes/jelly.js', './js/scenes/stars.js', './js/scenes/pond.js',
  './js/scenes/clay.js', './js/scenes/gravity.js', './js/scenes/waterfall.js', './js/scenes/kaleido.js', './js/scenes/mirror.js',
  './vendor/three.module.js',
  './icons/apple-touch-icon.png', './icons/icon-192.png', './icons/icon-512.png', './icons/icon-maskable-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  e.respondWith(
    caches.match(req, { ignoreSearch: true }).then((hit) => {
      if (hit) return hit;
      return fetch(req).then((res) => {
        if (res.ok) { const copy = res.clone(); caches.open(VERSION).then((c) => c.put(req, copy)); }
        return res;
      }).catch(() => (req.mode === 'navigate' ? caches.match('./index.html') : Response.error()));
    }),
  );
});
