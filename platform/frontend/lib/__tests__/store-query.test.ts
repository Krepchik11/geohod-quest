import { describe, it, expect } from 'vitest';
import { EMPTY_FACETS, type FacetFilters } from '../quest-filters';
import {
  DEFAULT_SORT,
  parseStoreQuery,
  pruneUnknownFacets,
  serializeStoreQuery,
  sortQuests,
} from '../store-query';

/**
 * The store's own state: how the shelf is ordered and how that plus the facets
 * survive a round trip through the URL — the source of truth on mount.
 */

const facets = (over: Partial<FacetFilters> = {}): FacetFilters => ({ ...EMPTY_FACETS, ...over });

describe('sortQuests', () => {
  const q = (name: string, rating_avg: number, rating_count: number) => ({ name, rating_avg, rating_count });

  it('by rating: ties break on rating_count', () => {
    const out = sortQuests([q('a', 4.8, 12), q('b', 4.8, 40), q('c', 5, 2)], 'rating');
    expect(out.map((x) => x.name)).toEqual(['c', 'b', 'a']);
  });

  it('by rating: unrated quests never outrank rated ones', () => {
    const out = sortQuests([q('unrated', 0, 0), q('low', 3.1, 4)], 'rating');
    expect(out.map((x) => x.name)).toEqual(['low', 'unrated']);
  });

  it('by name: Russian collation, not code points', () => {
    // By code point every uppercase Cyrillic letter precedes every lowercase
    // one, so «ЯБЛОКО» would come first; ru collation is case-insensitive here.
    const out = sortQuests([q('ЯБЛОКО', 0, 0), q('абажур', 0, 0), q('Ель', 0, 0)], 'name');
    expect(out.map((x) => x.name)).toEqual(['абажур', 'Ель', 'ЯБЛОКО']);
  });

  it('does not mutate the input', () => {
    const list = [q('b', 1, 1), q('a', 5, 5)];
    const copy = [...list];
    sortQuests(list, 'rating');
    expect(list).toEqual(copy);
  });
});

describe('the URL codec', () => {
  it('serializes a stable key order and skips empty keys', () => {
    expect(
      serializeStoreQuery({
        filters: facets({ city: ['Белград', 'Земун'], price: ['free'], complexity: ['low', 'medium'], hideOwned: true }),
        sort: 'name',
      }),
    ).toBe('?city=Белград,Земун&price=free&complexity=low,medium&owned=0&sort=name');
  });

  it('writes nothing at all for the default state', () => {
    expect(serializeStoreQuery({ filters: EMPTY_FACETS, sort: DEFAULT_SORT })).toBe('');
  });

  it('parse → serialize round-trips', () => {
    const url = '?city=Белград,Земун&price=free&complexity=low,medium&owned=0&sort=name';
    expect(serializeStoreQuery(parseStoreQuery(url))).toBe(url);
  });

  it('percent-encoded city values survive the round trip', () => {
    const parsed = parseStoreQuery('?city=%D0%9D%D0%BE%D0%B2%D0%B8-%D0%A1%D0%B0%D0%B4');
    expect(parsed.filters.city).toEqual(['Нови-Сад']);
    expect(serializeStoreQuery(parsed)).toBe('?city=Нови-Сад');
  });

  it('drops unknown values of closed sets silently, keeping the known ones', () => {
    const { filters, sort } = parseStoreQuery(
      '?complexity=low,extreme&age=kids,ancient&price=free,barter&owned=maybe&sort=new',
    );
    expect(filters.complexity).toEqual(['low']);
    expect(filters.age).toEqual(['kids']);
    expect(filters.price).toEqual(['free']);
    expect(filters.hideOwned).toBe(false);
    // «Сначала новые» has no wire field yet, so the key is not a known sort.
    expect(sort).toBe(DEFAULT_SORT);
  });

  it('ignores empty keys, blanks and duplicates', () => {
    const { filters } = parseStoreQuery('?city=Белград,,Белград&age=&tag=%20&complexity=');
    expect(filters.city).toEqual(['Белград']);
    expect(filters.age).toEqual([]);
    expect(filters.tag).toEqual([]);
    expect(filters.complexity).toEqual([]);
  });

  it('an absent query is the default state', () => {
    expect(parseStoreQuery('')).toEqual({ filters: EMPTY_FACETS, sort: DEFAULT_SORT });
  });
});

describe('pruneUnknownFacets', () => {
  const known = { cities: ['Белград', 'Ниш'], tags: ['еда', 'история'] };

  it('drops open-set values the catalog does not have (a link with an old tag)', () => {
    const pruned = pruneUnknownFacets(facets({ city: ['Белград', 'Атлантида'], tag: ['еда', 'ретро'] }), known);
    expect(pruned.city).toEqual(['Белград']);
    expect(pruned.tag).toEqual(['еда']);
  });

  it('returns the SAME object when nothing is unknown, so no history entry is written', () => {
    const f = facets({ city: ['Ниш'], tag: ['история'], complexity: ['low'] });
    expect(pruneUnknownFacets(f, known)).toBe(f);
  });
});
