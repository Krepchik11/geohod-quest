import type { MetadataRoute } from 'next';
import { API_BASE, type PublishedQuestWire } from '../lib/api';
import { SITE_URL, siteUrl } from '../lib/site';

/**
 * Every page a search engine should know about: the landing page, the two legal
 * pages, and one product page per quest ON SALE.
 *
 * The quest list comes from the same public catalogue the storefront renders,
 * so a delisted quest leaves the sitemap the moment it leaves the store — there
 * is no second list of "what is published" to fall out of date.
 *
 * A sitemap is never worth a failed deploy: an unreachable API yields the
 * static pages alone rather than an error.
 */
export const revalidate = 3600;

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  if (!SITE_URL) return [];
  const statics: MetadataRoute.Sitemap = [
    { url: siteUrl('/')!, changeFrequency: 'daily', priority: 1 },
    { url: siteUrl('/terms')!, changeFrequency: 'yearly', priority: 0.3 },
    { url: siteUrl('/privacy')!, changeFrequency: 'yearly', priority: 0.3 },
  ];
  return [...statics, ...(await questPages())];
}

async function questPages(): Promise<MetadataRoute.Sitemap> {
  const res = await fetch(`${API_BASE}/api/quests`, { next: { revalidate } }).catch(() => null);
  if (!res || !res.ok) return [];
  const quests = (await res.json()) as PublishedQuestWire[];
  return quests.map((q) => ({
    url: siteUrl(`/quest/${encodeURIComponent(q.quest_id)}/about`)!,
    changeFrequency: 'weekly' as const,
    priority: 0.8,
  }));
}
