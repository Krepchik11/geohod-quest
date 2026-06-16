/**
 * Post-finale catalog selection — the pure, deterministic core behind the
 * «Продолжите путешествие» screen the redesign adds after a quest is completed.
 * Kept out of the component so it is unit-testable and has a single responsibility:
 * pick which quests to invite the player into next.
 */
import type { PublishedQuestWire } from './api';

/** A quest card on the post-finale catalog. */
export interface CatalogCard {
  id: string;
  title: string;
  /** Single-letter monogram drawn on the cover when there is no image. */
  mark: string;
  cover: string | null;
}

/**
 * Other published quests to play next, excluding the one just completed.
 * Pure + order-preserving: GET /api/quests is already sorted by quest_id, so the
 * list stays stable across renders. The thin published metadata carries no
 * city/duration/rating yet, so cards render cover + title + CTA; richer fields can
 * be added here once the API exposes them, without touching the component.
 */
export function nextQuestsForCatalog(
  published: PublishedQuestWire[],
  currentQuestId: string,
): CatalogCard[] {
  return published
    .filter((q) => q.quest_id !== currentQuestId)
    .map((q) => ({
      id: q.quest_id,
      title: q.name,
      mark: monogram(q.name),
      cover: q.primary_comic,
    }));
}

/** First visible character of the title, uppercased — the cover monogram. */
function monogram(name: string): string {
  const ch = [...(name || '').trim()][0] || '?';
  return ch.toUpperCase();
}
