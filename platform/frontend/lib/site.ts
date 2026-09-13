/**
 * Where this deployment lives, as an absolute origin.
 *
 * Needed by everything that must name the site to someone else: the canonical
 * URL a share card resolves against, the sitemap, robots.txt. Unlike
 * `API_BASE`, a missing value here does NOT fail the build — the app works
 * perfectly without knowing its own address, it just cannot hand search engines
 * or a chat preview an absolute link, so those degrade instead of breaking a
 * deploy over a metadata concern.
 *
 * Set `NEXT_PUBLIC_SITE_URL` to the custom domain (https://quest.geohod.ru).
 * On Vercel, `VERCEL_PROJECT_PRODUCTION_URL` is the fallback — it names the
 * *.vercel.app host, which is a worse canonical than the custom domain but a
 * better one than nothing.
 */
function resolveSiteUrl(): string | null {
  const explicit = process.env.NEXT_PUBLIC_SITE_URL?.trim();
  if (explicit) return explicit.replace(/\/+$/, '');
  const vercel = process.env.VERCEL_PROJECT_PRODUCTION_URL?.trim();
  if (vercel) return `https://${vercel.replace(/\/+$/, '')}`;
  if (process.env.NODE_ENV !== 'production') return 'http://localhost:3000';
  return null;
}

export const SITE_URL = resolveSiteUrl();

/** An absolute URL on this site, or null when the deployment has no address. */
export function siteUrl(path: string): string | null {
  return SITE_URL ? new URL(path, `${SITE_URL}/`).toString() : null;
}
