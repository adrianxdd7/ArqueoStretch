/* ArqueoStretch - service worker
 *
 * Permite usar la aplicación sin conexión, que es lo normal en cuevas y
 * abrigos. Estrategia "stale-while-revalidate": se sirve al instante lo que
 * hay en caché y, en paralelo, se descarga la versión nueva para la próxima
 * vez. Así funciona sin cobertura sin quedarse anclada a una versión vieja.
 */

const CACHE_NAME = 'arqueostretch-v0.7';

const ASSETS = [
    './',
    './index.html',
    './styles.css',
    './app.js',
    './worker.js',
    './manifest.json',
    './favicon.svg',
    './icon-192.png',
    './icon-512.png'
];

self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME).then((cache) =>
            // Se añaden uno a uno: si falta un archivo opcional (un icono, por
            // ejemplo) la instalación no se cae entera.
            Promise.all(ASSETS.map((url) => cache.add(url).catch(() => null)))
        ).then(() => self.skipWaiting())
    );
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys()
            .then((keys) => Promise.all(
                keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))
            ))
            .then(() => self.clients.claim())
    );
});

self.addEventListener('fetch', (event) => {
    const request = event.request;

    if (request.method !== 'GET') return;

    const url = new URL(request.url);
    if (url.origin !== self.location.origin) return;

    event.respondWith(
        caches.match(request).then((cached) => {
            const network = fetch(request).then((response) => {
                if (response && response.status === 200 && response.type === 'basic') {
                    const copy = response.clone();
                    caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
                }
                return response;
            }).catch(() => cached);

            return cached || network;
        })
    );
});
