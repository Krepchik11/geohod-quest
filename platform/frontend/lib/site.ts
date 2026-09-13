/**
 * This deployment's own origin, for sitemap/robots/share links.
 * `NEXT_PUBLIC_SITE_URL` is the custom domain (https://quest.geohod.ru).
 *
 * Unlike `API_BASE` a missing value must NOT fail the build: the app works
 * without knowing its address, it just cannot emit absolute links.
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
