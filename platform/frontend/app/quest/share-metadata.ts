import type { Metadata } from 'next';
import { API_BASE, type ProductPageWire } from '../../lib/api';
import { shareCard } from '../../lib/storefront';

/**
 * The `<head>` for one quest: its own title, blurb and picture, plus the
 * per-quest manifest (§5) so an install scopes to this quest.
 *
 * Both quest routes use it — the product page at /quest/{id}/about, which is
 * the URL that gets pasted into chats, and the player at /quest/{id}, which is
 * where an owner's link lands. One `<head>` for one quest, stated once.
 *
 * The fetch is the same request the player shell already makes for the quest's
 * colours (same URL, same options), so Next serves both from one round-trip.
 * An unreachable API is not an error here: the page still renders, it just
 * carries the generic card.
 */
export async function questShareMetadata(questId: string): Promise<Metadata> {
  const manifest = `/quest/${encodeURIComponent(questId)}/manifest.webmanifest`;
  const quest = await fetchQuest(questId);
  if (!quest) return { title: 'Квест — GEOHOD QUEST', manifest };
  const card = shareCard(quest, API_BASE);
  return {
    title: card.title,
    description: card.description,
    manifest,
    openGraph: {
      type: 'article',
      siteName: 'GEOHOD QUEST',
      locale: 'ru_RU',
      title: card.title,
      description: card.description,
      images: card.image ? [card.image] : undefined,
    },
    twitter: {
      card: card.image ? 'summary_large_image' : 'summary',
      title: card.title,
      description: card.description,
      images: card.image ? [card.image] : undefined,
    },
  };
}

/** The published quest, or null (unpublished, offline, API down). */
export async function fetchQuest(questId: string): Promise<ProductPageWire | null> {
  const res = await fetch(`${API_BASE}/api/quests/${encodeURIComponent(questId)}`, {
    // Product data changes only on publish, so the same short TTL the manifest uses.
    next: { revalidate: 300 },
  }).catch(() => null);
  if (!res || !res.ok) return null;
  return (await res.json()) as ProductPageWire;
}
