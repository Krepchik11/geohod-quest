/**
 * The response headers every page is served with (next.config.ts).
 *
 * The session token lives in localStorage — the locked identity decision, and
 * the only shape that works for an anonymous-first offline PWA on a separate
 * API origin. That makes the browser-side guarantees the ones worth stating:
 * the page may not be framed, may not have its base URL rewritten, may not load
 * a plugin, and must not have its content type guessed. Each is asserted here so
 * a future edit to the config cannot quietly drop one.
 */
import { describe, it, expect } from 'vitest';
import nextConfig from '../../next.config';

/** Every header the config sets, flattened. */
async function siteWideHeaders(): Promise<Map<string, string>> {
  const rules = (await nextConfig.headers?.()) ?? [];
  const found = new Map<string, string>();
  for (const rule of rules) {
    for (const { key, value } of rule.headers) found.set(key.toLowerCase(), value);
  }
  return found;
}

describe('site-wide security headers', () => {
  it('applies every header to every path — there are no per-route exceptions', async () => {
    const rules = (await nextConfig.headers?.()) ?? [];
    expect(rules.map((r) => r.source)).toEqual(['/:path*']);
  });

  it('forbids framing, base-URL rewriting, plugins and content sniffing', async () => {
    const h = await siteWideHeaders();
    expect(h.get('x-content-type-options')).toBe('nosniff');
    expect(h.get('x-frame-options')).toBe('DENY');
    expect(h.get('referrer-policy')).toBe('strict-origin-when-cross-origin');

    const csp = h.get('content-security-policy') ?? '';
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("base-uri 'self'");
    expect(csp).toContain("object-src 'none'");
  });

  it('keeps the Telegram login popup working', async () => {
    // A bare `same-origin` COOP severs window.opener and breaks the login.
    const h = await siteWideHeaders();
    expect(h.get('cross-origin-opener-policy')).toBe('same-origin-allow-popups');
  });

  it('denies the device APIs this app never asks for', async () => {
    const policy = (await siteWideHeaders()).get('permissions-policy') ?? '';
    for (const feature of ['camera', 'microphone', 'geolocation', 'payment', 'usb']) {
      expect(policy).toContain(`${feature}=()`);
    }
  });

  it('pins HTTPS for return visits', async () => {
    const hsts = (await siteWideHeaders()).get('strict-transport-security') ?? '';
    expect(hsts).toMatch(/max-age=\d{7,}/);
  });
});
