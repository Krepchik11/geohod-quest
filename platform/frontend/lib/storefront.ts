import type { ProductPageWire, PublishedQuestWire } from './api';
import { plural } from './ru';

/**
 * Storefront pure helpers — one source of truth for the labels the landing,
 * the quest cards and the product page share (§2.2/§2.3/§3). No fabricated
 * values: everything derives from the live catalog/product payloads.
 */

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

/** The preview a pasted quest link produces: the tab title, the card blurb, the picture. */
export interface ShareCard {
  title: string;
  description: string;
  image: string | null;
}

/** What `shareCard` reads — the product payload, or a catalog row. */
type Shareable = Pick<ProductPageWire, 'name' | 'city' | 'duration' | 'description' | 'primary_comic'>;

/** Longest blurb a link preview shows before cutting it off itself. */
const BLURB_MAX = 200;

const clean = (s: string | null | undefined) => s?.trim() || null;

/** Cut on a word boundary so a preview never ends mid-word. */
function blurb(text: string): string {
  if (text.length <= BLURB_MAX) return text;
  const cut = text.slice(0, BLURB_MAX - 1);
  return `${cut.slice(0, cut.lastIndexOf(' ')).trimEnd() || cut}…`;
}

/**
 * A quest link is how this marketplace actually travels — pasted into a chat,
 * not typed. Every quest used to produce the same «О квесте — GEOHOD QUEST»
 * with no picture and no text, so the link said nothing about what was behind
 * it. This builds the preview out of what the author already wrote.
 *
 * Facts only: the city and the duration appear when the author filled them in
 * and are omitted otherwise — the store card follows the same rule. The city is
 * kept in the nominative (after a comma) rather than declined into a sentence,
 * because there is no correct way to decline an arbitrary place name and a
 * wrong case reads worse than a plain list.
 */
export function shareCard(quest: Shareable, mediaOrigin = ''): ShareCard {
  const city = clean(quest.city);
  const duration = clean(quest.duration);
  const written = clean(quest.description);
  const facts = [city, duration].filter(Boolean).join(', ');
  return {
    title: city ? `${quest.name} — городской квест, ${city}` : quest.name,
    description:
      written !== null
        ? blurb(written)
        : `Городской квест.${facts ? ` ${facts}.` : ''} Играйте офлайн — маршрут остаётся с вами.`,
    image: shareImage(clean(quest.primary_comic), mediaOrigin),
  };
}

/**
 * The cover as something a chat server can actually fetch: an absolute URL on
 * the host that serves the media.
 *
 * A cover ref is usually already absolute, but it can be `/`-rooted — that is
 * the documented shape when media is served through the API rather than a
 * bucket domain (`R2_PUBLIC_BASE_URL=https://api…/api/media`). Left relative it
 * would be resolved against the SITE's address, which serves no media at all,
 * and the preview would show a broken picture. `data:` and legacy id tokens are
 * dropped: a crawler cannot fetch either.
 */
function shareImage(ref: string | null, mediaOrigin: string): string | null {
  if (ref === null) return null;
  if (ref.startsWith('http')) return ref;
  if (ref.startsWith('/')) return mediaOrigin ? `${mediaOrigin.replace(/\/+$/, '')}${ref}` : null;
  return null;
}
