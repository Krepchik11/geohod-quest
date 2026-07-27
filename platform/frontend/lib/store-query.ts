import { AGE_TARGET_OPTIONS, COMPLEXITY_OPTIONS } from './constructor-model';
import { EMPTY_FACETS, FACET_KEYS, PRICE_OPTIONS, type FacetFilters, type PriceFacet } from './quest-filters';

/**
 * The store's own state: sort order + the URL it round-trips through. The URL is
 * the source of truth on mount, the panel holds a draft, and one apply is one
 * history entry. Pure — the React side lives in lib/useStoreQuery.
 *
 * The store search field is gone on purpose (city became a facet); if it comes
 * back — needed at roughly 30 quests — it belongs in FacetFilters so the
 * predicate, this codec and both bars pick it up at once.
 */

/* ── Sorting ─────────────────────────────────────────────────────────────────
   «Сначала новые» is deliberately absent: PublishedQuestWire carries neither
   published_at nor created_at, so there is nothing to sort by. Once the wire
   grows a snapshot publish date, add 'new' here and make it the default. */

export type StoreSort = 'rating' | 'name';
export const DEFAULT_SORT: StoreSort = 'rating';

export const SORT_OPTIONS: Array<{ key: StoreSort; label: string; full: string }> = [
  { key: 'rating', label: 'по рейтингу', full: 'По рейтингу' },
  { key: 'name', label: 'по названию', full: 'По названию (А–Я)' },
];

export interface SortableQuest {
  name: string;
  rating_avg: number;
  rating_count: number;
}

/** Returns a new array; unrated quests (rating_count === 0) sort last whatever
 *  their nominal rating_avg is — a 0.0 average is «no data», not a bad quest. */
export function sortQuests<T extends SortableQuest>(list: T[], sort: StoreSort): T[] {
  const out = list.slice();
  if (sort === 'name') {
    out.sort((a, b) => a.name.localeCompare(b.name, 'ru'));
    return out;
  }
  out.sort((a, b) => {
    const rated = Number(b.rating_count > 0) - Number(a.rating_count > 0);
    return rated || b.rating_avg - a.rating_avg || b.rating_count - a.rating_count;
  });
  return out;
}

/* ── The URL ─────────────────────────────────────────────────────────────────
   `?city=Белград,Земун&price=free&complexity=low,medium&owned=0&sort=name` */

export interface StoreQuery {
  filters: FacetFilters;
  sort: StoreSort;
}

export const DEFAULT_STORE_QUERY: StoreQuery = { filters: EMPTY_FACETS, sort: DEFAULT_SORT };

/** Percent-encode ONLY what would break the query or the comma-separated list,
 *  so a shared link stays readable: `?city=Белград` and not `?city=%D0%91…`. */
const RESERVED = /[%&#,+?=/\s]/g;
const enc = (v: string) =>
  v.replace(RESERVED, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`);

const dec = (v: string): string | null => {
  try {
    return decodeURIComponent(v);
  } catch {
    return null; // a malformed escape is an unknown value — drop it silently
  }
};

const COMPLEXITY_KEYS = COMPLEXITY_OPTIONS.map((o) => o.key as string);
const AGE_KEYS = AGE_TARGET_OPTIONS.map((o) => o.key as string);
const PRICE_KEYS = PRICE_OPTIONS.map((o) => o.key as string);
const SORT_KEYS = SORT_OPTIONS.map((o) => o.key as string);

/** Split one raw `a,b` value list, decode each part, drop blanks/duplicates and
 *  anything outside `allowed` (a closed set) — an old link must not blow up.
 *  Splitting BEFORE decoding is what lets a value contain an escaped comma, so
 *  URLSearchParams (which decodes first) cannot do this job. */
function values(raw: string | undefined, allowed?: string[]): string[] {
  if (!raw) return [];
  const out: string[] = [];
  for (const part of raw.split(',')) {
    const v = dec(part)?.trim();
    if (!v) continue;
    if (allowed && !allowed.includes(v)) continue;
    if (!out.includes(v)) out.push(v);
  }
  return out;
}

export function parseStoreQuery(search: string): StoreQuery {
  const raw = new Map<string, string>();
  for (const pair of search.replace(/^[?#]/, '').split('&')) {
    if (!pair) continue;
    const eq = pair.indexOf('=');
    const key = dec(eq === -1 ? pair : pair.slice(0, eq));
    if (key && !raw.has(key)) raw.set(key, eq === -1 ? '' : pair.slice(eq + 1));
  }
  const sort = values(raw.get('sort'), SORT_KEYS)[0] as StoreSort | undefined;
  return {
    filters: {
      city: values(raw.get('city')),
      price: values(raw.get('price'), PRICE_KEYS) as PriceFacet[],
      complexity: values(raw.get('complexity'), COMPLEXITY_KEYS),
      age: values(raw.get('age'), AGE_KEYS),
      tag: values(raw.get('tag')),
      hideOwned: raw.get('owned') === '0',
    },
    sort: sort ?? DEFAULT_SORT,
  };
}

/** `''` for the default state — an empty key is never written. */
export function serializeStoreQuery({ filters, sort }: StoreQuery): string {
  const parts: string[] = [];
  for (const key of FACET_KEYS) {
    const vals = filters[key];
    if (vals.length) parts.push(`${key}=${vals.map(enc).join(',')}`);
  }
  if (filters.hideOwned) parts.push('owned=0');
  if (sort !== DEFAULT_SORT) parts.push(`sort=${sort}`);
  return parts.length ? `?${parts.join('&')}` : '';
}

/** Open sets (city, tag) can only be validated against the loaded catalog, which
 *  arrives after the URL is read. Returns the SAME object when nothing is
 *  unknown, so the caller can skip rewriting the URL. */
export function pruneUnknownFacets(
  f: FacetFilters,
  known: { cities: string[]; tags: string[] },
): FacetFilters {
  const city = f.city.filter((c) => known.cities.includes(c));
  const tag = f.tag.filter((t) => known.tags.includes(t));
  if (city.length === f.city.length && tag.length === f.tag.length) return f;
  return { ...f, city, tag };
}
