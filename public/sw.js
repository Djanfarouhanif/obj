/* Service Worker — Copilote de Parole
   Rend l'application disponible hors-ligne en mettant en cache la coquille de l'app.
   Les appels /api/* ne sont JAMAIS mis en cache : la synchronisation est geree
   par script.js (etat local + file d'attente). */

const CACHE = 'cdp-cache-v1';

// Ressources locales pre-cachees a l'installation
const ASSETS = [
  './',
  './index.html',
  './script.js',
  './program.json',
  './manifest.webmanifest'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;

  // On ne gere que les GET. POST/PUT/DELETE partent au reseau (et echouent hors-ligne -> file d'attente cote app).
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // Ne jamais mettre l'API en cache : on laisse le reseau gerer (et l'app gere le hors-ligne).
  if (url.origin === self.location.origin && url.pathname.startsWith('/api/')) return;

  // Strategie "cache d'abord, puis reseau en arriere-plan" (stale-while-revalidate).
  event.respondWith(
    caches.match(req).then((cached) => {
      const network = fetch(req).then((resp) => {
        if (resp && resp.status === 200 && (url.origin === self.location.origin || resp.type === 'basic' || resp.type === 'cors')) {
          const clone = resp.clone();
          caches.open(CACHE).then((c) => c.put(req, clone)).catch(() => {});
        }
        return resp;
      }).catch(() => cached);
      return cached || network;
    })
  );
});
