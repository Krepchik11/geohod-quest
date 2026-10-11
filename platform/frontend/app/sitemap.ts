import type { MetadataRoute } from 'next';
import { API_BASE, type PublishedQuestWire } from '../lib/api';
import { ARCHIVE_LIMIT, citiesOf, cityPath, eventPath, fetchAfisha } from '../lib/afisha';
import { questShareUrl, siteUrl } from '../lib/share';

/** Rebuilt at most once an hour; new announcements also reach search engines by IndexNow. */
export const revalidate = 3600;

/** The quests on sale; none when the API cannot answer (the sitemap still serves). */
async function publishedQuests(): Promise<PublishedQuestWire[]> {
  const res = await fetch(`${API_BASE}/api/quests`, { next: { revalidate: 3600 } }).catch(() => null);
  return res?.ok ? ((await res.json()) as PublishedQuestWire[]) : [];
}

/**
 * /sitemap.xml — every public page: the shop, each quest's page and, while
 * the «Афиша» is on, its hub, archive, city pages and every announcement.
 */
export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const base = siteUrl();
  const [quests, upcoming, past] = await Promise.all([
    publishedQuests(),
    fetchAfisha('upcoming').catch(() => null),
    fetchAfisha('past', ARCHIVE_LIMIT).catch(() => null),
  ]);
  const pages: MetadataRoute.Sitemap = [
    { url: base, changeFrequency: 'weekly', priority: 1 },
    { url: `${base}/rules`, changeFrequency: 'monthly', priority: 0.6 },
    { url: `${base}/privacy`, changeFrequency: 'yearly', priority: 0.2 },
    { url: `${base}/terms`, changeFrequency: 'yearly', priority: 0.2 },
    ...quests.map((q) => ({ url: questShareUrl(q.quest_id), changeFrequency: 'weekly' as const, priority: 0.8 })),
  ];
  if (upcoming && past) {
    const all = [...upcoming, ...past];
    pages.push(
      { url: `${base}/afisha`, changeFrequency: 'daily', priority: 0.9 },
      { url: `${base}/afisha/arhiv`, changeFrequency: 'weekly', priority: 0.4 },
      ...citiesOf(all).map((c) => ({ url: `${base}${cityPath(c.slug)}`, changeFrequency: 'daily' as const, priority: 0.8 })),
      ...upcoming.map((e) => ({ url: `${base}${eventPath(e)}`, changeFrequency: 'daily' as const, priority: 0.7 })),
      ...past.map((e) => ({ url: `${base}${eventPath(e)}`, changeFrequency: 'yearly' as const, priority: 0.3 })),
    );
  }
  return pages;
}
