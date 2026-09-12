import type { MetadataRoute } from 'next';
import { siteUrl } from '../lib/site';

/**
 * A marketplace that no one can find is a marketplace no one visits, and the
 * site shipped without a robots.txt or a sitemap at all.
 *
 * What is open: the landing page, the store and every quest's product page —
 * the pages the shop wants found. What is closed: the player (grant-gated), the
 * account surfaces and the two internal desks. None of them are secret, and
 * none of them are useful in a search result: a crawler following /quest/{id}
 * only reaches a gate, and indexing /profile or /admin wastes the crawl budget
 * that should go to the catalogue. Access is still enforced by the server —
 * robots.txt is a hint to well-behaved crawlers, never a control.
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
