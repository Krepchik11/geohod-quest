import { afterEach, describe, expect, it, vi } from 'vitest';
import { GET } from '../route';

/**
 * /go/<slug> — a printed QR invitation (flag promo_qr): the API resolves the
 * slug and counts the scan; the guest lands on the quest page with the code,
 * or in the shop when the link leads nowhere.
 */
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) Safari/604.1';

function scan(slug: string, userAgent: string | null = IPHONE) {
  const headers = userAgent ? { 'user-agent': userAgent } : undefined;
  return GET(new Request(`https://quest.geohod.ru/go/${slug}`, { headers }), {
    params: Promise.resolve({ slug }),
  });
}

afterEach(() => vi.unstubAllGlobals());

describe('GET /go/[slug]', () => {
  it('sends the guest to the quest page with the code, past every cache', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ quest_id: 'q 1', code: 'GEO-7KX2M9' }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const res = await scan('7KX2M9');

    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('https://quest.geohod.ru/quest/q%201/about?promo=GEO-7KX2M9');
    expect(res.headers.get('cache-control')).toBe('no-store');
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toMatch(/\/api\/go\/7KX2M9$/);
    expect(init).toMatchObject({ method: 'POST', cache: 'no-store' });
    // The visitor's agent goes along: the API counts people, not link previews.
    expect(init.headers).toEqual({ 'User-Agent': IPHONE });
  });

  it('opens the shop when the link leads nowhere or the API is away', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 404 })));
    expect((await scan('NOPE00')).headers.get('location')).toBe('https://quest.geohod.ru/');

    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    expect((await scan('7KX2M9')).headers.get('location')).toBe('https://quest.geohod.ru/');
  });

  it('sends no agent it was not given', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 404 }));
    vi.stubGlobal('fetch', fetchMock);
    await scan('7KX2M9', null);
    expect(fetchMock.mock.calls[0][1].headers).toEqual({});
  });
});
