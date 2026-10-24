/* TradeBrain service worker: app shell works offline; market and broker calls are never cached. */
const CACHE = 'tradebrain-v10';
const SHELL = ['./', './index.html', './css/styles.css', './js/indicators.js', './js/scanner.js', './js/council.js', './js/strategies.js', './js/councilx.js', './js/risk.js', './js/engine.js', './js/brain.js', './js/executors.js', './js/controller.js', './js/chart.js', './js/ui2.js', './js/gates.js', './js/store.js', './js/sizing.js', './js/execution.js', './js/live.js', './js/app.js', './manifest.json', './icon.svg'];
self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL))); self.skipWaiting(); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(k => Promise.all(k.filter(x => x !== CACHE).map(x => caches.delete(x))))); self.clients.claim(); });
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== location.origin) return;           // let the network handle APIs
  e.respondWith(fetch(e.request).then(r => { const copy = r.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); return r; })   // network first, so updates arrive
    .catch(() => caches.match(e.request).then(m => m || caches.match('./index.html'))));
});
