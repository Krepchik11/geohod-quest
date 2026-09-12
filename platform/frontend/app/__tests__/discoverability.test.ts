/**
 * robots.txt and sitemap.xml — the two files that decide whether a search
 * engine can find the shop at all. The site shipped without either.
 *
 * Both are asserted on behaviour, not shape: what is open to a crawler, what is
 * closed, which quests are listed, and — the property that keeps a deploy
 * safe — that neither needs the API or the site address to succeed.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';

const ORIGIN = 'https://site.test';

/** Load the route modules against a given environment, fresh each time. */
async function load(env: Record<string, string | undefined>) {
  vi.resetModules();
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  return {
    robots: (await import('../robots')).default,
    sitemap: (await import('../sitemap')).default,
  };
}

afterEach(() => {
  delete process.env.NEXT_PUBLIC_SITE_URL;
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('robots.txt', () => {
  it('opens the shop and closes the desks, the player and the account pages', async () => {
    const { robots } = await load({ NEXT_PUBLIC_SITE_URL: ORIGIN });
    const rules = robots().rules as { allow: string; disallow: string[] };
    expect(rules.allow).toBe('/');
    expect(rules.disallow).toEqual(
      expect.arrayContaining(['/admin', '/quest-editor', '/profile', '/my-quests', '/auth']),
    );
    expect(robots().sitemap).toBe(`${ORIGIN}/sitemap.xml`);
  });

  it('omits the sitemap line rather than pointing at a guessed address (production)', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    const { robots } = await load({ NEXT_PUBLIC_SITE_URL: '', NEXT_PUBLIC_API_URL: 'https://api.test' });
    expect(robots().sitemap).toBeUndefined();
  });
});

describe('sitemap.xml', () => {
  const catalog = (quests: { quest_id: string }[]) =>
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(quests), { status: 200 })),
    );

  it('lists the landing page, the legal pages and one product page per quest on sale', async () => {
    catalog([{ quest_id: 'fortress' }, { quest_id: 'tram/1' }]);
    const { sitemap } = await load({ NEXT_PUBLIC_SITE_URL: ORIGIN });
    const urls = (await sitemap()).map((e) => e.url);
    expect(urls).toEqual([
      `${ORIGIN}/`,
      `${ORIGIN}/terms`,
      `${ORIGIN}/privacy`,
      `${ORIGIN}/quest/fortress/about`,
      `${ORIGIN}/quest/tram%2F1/about`,
    ]);
  });

  it('keeps the static pages when the catalogue cannot be reached', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new Error('offline'))));
    const { sitemap } = await load({ NEXT_PUBLIC_SITE_URL: ORIGIN });
    expect((await sitemap()).map((e) => e.url)).toEqual([
      `${ORIGIN}/`,
      `${ORIGIN}/terms`,
      `${ORIGIN}/privacy`,
    ]);
  });

  it('is empty, not wrong, when a production deployment was never told its address', async () => {
    catalog([{ quest_id: 'fortress' }]);
    vi.stubEnv('NODE_ENV', 'production');
    const { sitemap } = await load({ NEXT_PUBLIC_SITE_URL: '', NEXT_PUBLIC_API_URL: 'https://api.test' });
    expect(await sitemap()).toEqual([]);
  });
});
