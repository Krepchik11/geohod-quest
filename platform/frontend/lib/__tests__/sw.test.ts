/**
 * Service-worker routing (public/sw.js). The SW is browser-only classic-script code,
 * so we load its source into a Node VM with mocked `self`/`caches`/`fetch` and call
 * `handleFetch` directly — proving the fetch-routing decisions without a browser:
 *   - cross-origin precached media (R2)  -> served from the quest-bundle cache (offline)
 *   - cross-origin not precached (API)   -> network
 *   - same-origin /api/                  -> network
 *   - same-origin shell asset            -> stale-while-revalidate (not the bundle cache)
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const HERE = dirname(fileURLToPath(import.meta.url));
const ORIGIN = 'https://app.test';

/** Minimal Cache Storage backed by Maps of url -> Response. */
function makeCaches() {
  const stores = new Map<string, Map<string, Response>>();
  const cacheFor = (name: string) => {
    if (!stores.has(name)) stores.set(name, new Map());
    const m = stores.get(name)!;
    return {
      match: async (req: Request | string) => m.get(typeof req === 'string' ? req : req.url),
      put: async (req: Request | string, res: Response) =>
        void m.set(typeof req === 'string' ? req : req.url, res),
      add: async (url: string) => void m.set(url, new Response('cached:' + url)),
    };
  };
  return {
    stores,
    keys: async () => [...stores.keys()],
    open: async (name: string) => cacheFor(name),
    match: async (req: Request | string) => {
      const url = typeof req === 'string' ? req : req.url;
      for (const m of stores.values()) if (m.has(url)) return m.get(url);
      return undefined;
    },
  };
}

/** Load sw.js into a fresh VM; returns the global (self) exposing handleFetch. */
function loadSw() {
  const src = readFileSync(resolve(HERE, '../../public/sw.js'), 'utf8');
  const caches = makeCaches();
  const ctx: Record<string, unknown> = {
    caches,
    fetch: async (req: Request | string) =>
      new Response('network:' + (typeof req === 'string' ? req : req.url)),
    URL,
    Request,
    Response,
    console,
    location: { origin: ORIGIN },
    addEventListener: () => {},
    skipWaiting: async () => {},
    clients: { claim: async () => {} },
  };
  ctx.self = ctx; // sw.js references `self` as the global
  vm.createContext(ctx);
  vm.runInContext(src, ctx);
  return ctx as {
    handleFetch: (r: Request) => Promise<Response>;
    caches: ReturnType<typeof makeCaches>;
  };
}

const body = (r: Response) => r.text();

describe('sw.js handleFetch routing', () => {
  it('serves precached cross-origin (R2) media from the quest-bundle cache', async () => {
    const sw = loadSw();
    const mediaUrl = 'https://media.test/abc123';
    const bundle = await sw.caches.open('quest-bundle-snap-1');
    await bundle.put(mediaUrl, new Response('IMG-BYTES'));
    const res = await sw.handleFetch(new Request(mediaUrl));
    expect(await body(res)).toBe('IMG-BYTES'); // from cache, not network
  });

  it('cross-origin media not yet precached falls through to network', async () => {
    const sw = loadSw();
    const res = await sw.handleFetch(new Request('https://media.test/missing'));
    expect(await body(res)).toBe('network:https://media.test/missing');
  });

  it('cross-origin API GET is network-only (never served from a bundle cache)', async () => {
    const sw = loadSw();
    const res = await sw.handleFetch(new Request('https://api.test/api/quests/x/bundle'));
    expect(await body(res)).toBe('network:https://api.test/api/quests/x/bundle');
  });

  it('same-origin shell asset uses stale-while-revalidate (serves the shell cache)', async () => {
    const sw = loadSw();
    const assetUrl = `${ORIGIN}/_next/static/chunk.js`;
    const shell = await sw.caches.open('shell-v1');
    await shell.put(assetUrl, new Response('CACHED-CHUNK'));
    const res = await sw.handleFetch(new Request(assetUrl));
    expect(await body(res)).toBe('CACHED-CHUNK'); // SWR returns the cached shell asset
  });
});
