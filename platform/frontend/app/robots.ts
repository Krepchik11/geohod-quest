import type { MetadataRoute } from 'next';
import { siteUrl } from '../lib/share';

/** Service sections nobody searches for: the admin, the editor, a player's own pages. */
const PRIVATE = ['/admin', '/quest-editor', '/profile', '/my-quests', '/auth'];

/**
 * The search and AI crawlers named explicitly, so a blanket rule some host
 * adds later cannot shut them out by accident. OAI-SearchBot is what puts a
 * site into ChatGPT's search answers; Claude-SearchBot and PerplexityBot do
 * the same for Claude and Perplexity.
 */
const CRAWLERS = [
  'Googlebot',
  'YandexBot',
  'Bingbot',
  'OAI-SearchBot',
  'ChatGPT-User',
  'GPTBot',
  'Claude-SearchBot',
  'Claude-User',
  'ClaudeBot',
  'PerplexityBot',
  'Perplexity-User',
];

/** /robots.txt — everything public is open, the sitemap lists it. */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      { userAgent: '*', allow: '/', disallow: PRIVATE },
      { userAgent: CRAWLERS, allow: '/', disallow: PRIVATE },
    ],
    sitemap: `${siteUrl()}/sitemap.xml`,
  };
}
