import type { MetadataRoute } from 'next';
import { siteUrl } from '../lib/site';

/**
 * Open: landing, store, product pages. Closed: the player (grant-gated), the
 * account surfaces and the two internal desks — not secret, just useless in a
 * search result and a waste of crawl budget. Access is enforced by the server.
 */
export default function robots(): MetadataRoute.Robots {
  const sitemap = siteUrl('/sitemap.xml');
  return {
    rules: {
      userAgent: '*',
      allow: '/',
      disallow: ['/admin', '/quest-editor', '/profile', '/my-quests', '/auth'],
    },
    ...(sitemap ? { sitemap } : {}),
  };
}
