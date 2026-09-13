import type { Metadata } from 'next';
import { API_BASE, type ProductPageWire } from '../../lib/api';
import { shareCard } from '../../lib/storefront';

/**
 * The <head> for one quest — used by both the product page (the URL that gets
 * pasted) and the player. The fetch is the same request the player shell makes
 * for the quest colours, so Next serves both from one round-trip.
 */
export async function questShareMetadata(questId: string): Promise<Metadata> {
  const manifest = `/quest/${encodeURIComponent(questId)}/manifest.webmanifest`;
  const quest = await fetchQuest(questId);
  if (!quest) return { title: 'Квест — GEOHOD QUEST', manifest };
  const card = shareCard(quest, API_BASE);
  // Stated once: Next fills og:* from title/description, then twitter:* from
  // og:* — including summary vs summary_large_image.
  return {
    title: card.title,
    description: card.description,
    manifest,
    openGraph: {
      type: 'article',
      siteName: 'GEOHOD QUEST',
      locale: 'ru_RU',
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
