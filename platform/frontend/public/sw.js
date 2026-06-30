/**
 * GeoQuest service worker — app shell + offline quest media.
 *
 * Policy (see openspec change pwa-offline, design Decision 8):
 *  - Navigations + same-origin static assets: stale-while-revalidate into a
 *    versioned shell cache; offline navigation falls back to the cached page
 *    (/quest is cached ignoring its search params so ?golden=/?quest= variants
 *    boot offline).
 *  - Quest media (incl. CROSS-ORIGIN R2 URLs) precached into `quest-bundle-*`
 *    caches by the download flow is served cache-first, so offline play has its
 *    images. (Replaces the old blanket cross-origin bypass, which left externalized
 *    media unreachable offline.)
 *  - /api/: network-only. Quest data lives in IndexedDB — an SW cache of API
 *    responses would be a second, stale source of truth.
 *  - Non-GET requests are never intercepted; the fact queue owns sync.
 *  - `quest-bundle-*` caches are never cleaned here — they are evicted only by
 *    explicit bundle deletion.
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

/**
 * First hit across the `quest-bundle-*` caches (media precached by the download
 * flow), or undefined. Origin-agnostic: it serves whatever was precached — including
 * cross-origin R2 URLs — so offline play works wherever media is hosted.
 */
async function matchBundleCache(request) {
  const names = await caches.keys();
  for (const name of names) {
    if (!name.startsWith('quest-bundle-')) continue;
    const cache = await caches.open(name);
    const hit = await cache.match(request);
    if (hit) return hit;
  }
  return undefined;
}

function isShellAsset(request, url) {
  return (
    request.mode === 'navigate' ||
    url.pathname.startsWith('/_next/static/') ||
    url.pathname.startsWith('/assets/') ||
    url.pathname.endsWith('.css') ||
    url.pathname.endsWith('.js') ||
    url.pathname.endsWith('.png') ||
    url.pathname.endsWith('.svg') ||
    url.pathname.endsWith('.woff2')
  );
}

async function handleFetch(request) {
  const url = new URL(request.url);

  // Cross-origin (the API host + R2 media): serve precached quest media cache-first
  // (offline play), else network. API GETs simply miss the cache and go to network;
  // API mutations are POSTs and never reach here. The bundle-cache lookup runs only
  // for cross-origin requests, so the same-origin shell path keeps zero overhead.
  if (url.origin !== self.location.origin) {
    return (await matchBundleCache(request)) || fetch(request);
  }

  // Same-origin (unchanged): API is network-only (data lives in IndexedDB); shell +
  // same-origin static use stale-while-revalidate; anything else passes through.
  if (url.pathname.startsWith('/api/')) return fetch(request);
  if (isShellAsset(request, url)) return staleWhileRevalidate(request);
  return fetch(request);
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return; // never intercept mutations; the fact queue owns sync
  event.respondWith(handleFetch(request));
});
