/**
 * The quest attribute filter — ONE predicate for every quest list (the store
 * toolbar and the constructor dashboard). No React here on purpose: two copies
 * of one rule always drift apart, and the panels are only drafts of this state.
 *
 * Every facet is a SET: an empty array means «any», values inside a facet are
 * OR'ed and the facets are AND'ed. The constructor is single-select and passes
 * one-element arrays (see `singleValueFacets`) rather than a second predicate.
 *
 * The store's sorting and URL state live next door in lib/store-query.
 */

export type PriceFacet = 'free' | 'paid';

/** Facet keys in URL order; `hideOwned` is a flag, not a set, and stays out. */
export const FACET_KEYS = ['city', 'price', 'complexity', 'age', 'tag'] as const;
export type FacetKey = (typeof FACET_KEYS)[number];

export interface FacetFilters {
  /** Exact city labels as they arrive from the catalog. */
  city: string[];
  price: PriceFacet[];
  complexity: string[];
  age: string[];
  tag: string[];
  /** Hide the quests the viewer already owns. */
  hideOwned: boolean;
}

/** The quest shape the predicate needs. `city`/`price` are optional because the
 *  constructor row has no storefront price and no city. */
export interface FilterableQuest {
  city?: string | null;
  price?: number | null;
  complexity: string | null;
  age_target: string | null;
  tags: string[];
}

export const EMPTY_FACETS: FacetFilters = Object.freeze({
  city: [],
  price: [],
  complexity: [],
  age: [],
  tag: [],
  hideOwned: false,
});

export const PRICE_OPTIONS: Array<{ key: PriceFacet; label: string }> = [
  { key: 'free', label: 'Бесплатные' },
  { key: 'paid', label: 'Платные' },
];

/**
 * `null` attributes (legacy/direct publishes) match only the «any» facet, and
 * `price === null` is neither free nor paid — «Бесплатные» + «Платные» together
 * mean «the price is known» and legitimately hide legacy rows.
 */
export function matchesAttrs(f: FacetFilters, q: FilterableQuest, owned = false): boolean {
  if (f.city.length && !f.city.includes(q.city ?? '')) return false;
  if (f.complexity.length && !f.complexity.includes(q.complexity ?? '')) return false;
  if (f.age.length && !f.age.includes(q.age_target ?? '')) return false;
  if (f.tag.length && !q.tags.some((t) => f.tag.includes(t))) return false;
  if (f.price.length) {
    const price = q.price ?? null;
    const free = f.price.includes('free') && price === 0;
    const paid = f.price.includes('paid') && price !== null && price > 0;
    if (!free && !paid) return false;
  }
  if (f.hideOwned && owned) return false;
  return true;
}

/** The constructor picks at most one value per facet — one predicate, one call. */
export function singleValueFacets(v: { complexity: string; age: string; tag: string }): FacetFilters {
  const one = (s: string) => (s === '' ? [] : [s]);
  return { ...EMPTY_FACETS, complexity: one(v.complexity), age: one(v.age), tag: one(v.tag) };
}

/** The badge counts chosen VALUES, not facets: three chips of one facet read 3. */
export function countActiveValues(f: FacetFilters): number {
  return FACET_KEYS.reduce((n, k) => n + f[k].length, 0) + (f.hideOwned ? 1 : 0);
}
