import type { PublishedQuestWire } from './api';

/**
 * Storefront pure helpers — one source of truth for the labels the landing,
 * the quest cards and the product page share (§2.2/§2.3/§3). No fabricated
 * values: everything derives from the live catalog/product payloads.
 */

/** Russian plural picker: forms = [1, 2–4, 5–0]. */
export function plural(n: number, one: string, few: string, many: string): string {
  const m = n % 10;
  const h = n % 100;
  if (m === 1 && h !== 11) return one;
  if (m >= 2 && m <= 4 && (h < 12 || h > 14)) return few;
  return many;
}

export const ratingPlural = (n: number) => plural(n, 'оценка', 'оценки', 'оценок');
export const playersPlural = (n: number) => plural(n, 'игрок сыграл', 'игрока сыграли', 'игроков сыграли');
export const questPlural = (n: number) => plural(n, 'квест', 'квеста', 'квестов');
export const cityPlural = (n: number) => plural(n, 'город', 'города', 'городов');

/** One-decimal rating without a trailing ".0" (5 → "5", 4.75 → "4.8"). */
export function fmtRating(avg: number): string {
  return (Math.round(avg * 10) / 10).toString();
}

/** Price chip text: rubles, «Бесплатно» for 0, or "" when unset (legacy). */
export function priceLabel(price: number | null): string {
  if (price == null) return '';
  return price === 0 ? 'Бесплатно' : `${price} ₽`;
}

export interface CatalogFacts {
  quests: number;
  cities: number;
  /** Weighted mean of rating_avg over rating_count; null while nothing is rated. */
  avg: number | null;
  ratings: number;
}

/** §2.3 hero facts from the live catalog response. */
export function catalogFacts(quests: PublishedQuestWire[]): CatalogFacts {
  const cities = new Set(
    quests
      .map((q) => q.city?.trim().toLowerCase())
      .filter((c): c is string => !!c),
  );
  let ratings = 0;
  let weighted = 0;
  for (const q of quests) {
    ratings += q.rating_count;
    weighted += q.rating_avg * q.rating_count;
  }
  return {
    quests: quests.length,
    cities: cities.size,
    avg: ratings > 0 ? weighted / ratings : null,
    ratings,
  };
}

/** Display strings for the hero facts row; rating is null while unrated. */
export function factsLine(f: CatalogFacts): { quests: string; cities: string; rating: string | null } {
  return {
    quests: `${f.quests} ${questPlural(f.quests)}`,
    cities: `${f.cities} ${cityPlural(f.cities)}`,
    rating: f.avg == null ? null : `${fmtRating(f.avg)} — средняя оценка игроков`,
  };
}
