/**
 * GeoQuest service worker — app shell only.
 *
 * Policy (see openspec change pwa-offline, design Decision 8):
 *  - Navigations + same-origin static assets: stale-while-revalidate into a
 *    versioned shell cache; offline navigation falls back to the cached page
 *    (/quest is cached ignoring its search params so ?golden=/?quest= variants
 *    boot offline).
 *  - /api/: network-only. Quest data lives in IndexedDB — an SW cache of API
 *    responses would be a second, stale source of truth.
 *  - Non-GET requests are never intercepted; the fact queue owns sync.
 *  - `quest-bundle-*` caches (media, written by the download flow) are never
 *    cleaned here — they are evicted only by explicit bundle deletion.
 */
const SHELL_CACHE = 'shell-v1';

/** Cache key for a request — /quest collapses its query variants. */
function cacheKeyFor(request) {
  const url = new URL(request.url);
  if (url.pathname === '/quest') return new Request(url.origin + url.pathname);
  return request;
}

self.addEventListener('install', (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(
        names
          .filter((n) => n !== SHELL_CACHE && !n.startsWith('quest-bundle-'))
          .map((n) => caches.delete(n))
      );
      await self.clients.claim();
    })()
  );
});

async function staleWhileRevalidate(request) {
  const cache = await caches.open(SHELL_CACHE);
  const key = cacheKeyFor(request);
  const cached = await cache.match(key);
  const refresh = fetch(request)
    .then((response) => {
      if (response.ok) cache.put(key, response.clone());
      return response;
    })
    .catch(() => undefined);
  if (cached) {
    return cached; // refresh continues in the background
  }
  const fresh = await refresh;
  if (fresh) return fresh;
  // Offline navigation with nothing cached for this exact page: any cached
  // /quest shell is better than a browser error page.
  if (request.mode === 'navigate') {
    const questShell = await cache.match(new Request(self.location.origin + '/quest'));
    if (questShell) return questShell;
  }
  return Response.error();
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return; // never intercept mutations
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return; // cross-origin (incl. the API host)
  if (url.pathname.startsWith('/api/')) return; // network-only: data lives in IndexedDB

  const isShellAsset =
    request.mode === 'navigate' ||
    url.pathname.startsWith('/_next/static/') ||
    url.pathname.startsWith('/assets/') ||
    url.pathname.endsWith('.css') ||
    url.pathname.endsWith('.js') ||
    url.pathname.endsWith('.png') ||
    url.pathname.endsWith('.svg') ||
    url.pathname.endsWith('.woff2');

  if (isShellAsset) {
    event.respondWith(staleWhileRevalidate(request));
  }
});
