import { describe, it, expect } from 'vitest';
import {
  EMPTY_FACETS,
  countActiveValues,
  matchesAttrs,
  singleValueFacets,
  type FacetFilters,
  type FilterableQuest,
} from '../quest-filters';

/**
 * The store toolbar and the constructor dashboard share ONE predicate, so the
 * rules live here and nowhere else: an empty facet is «any», values inside a
 * facet are OR'ed, facets are AND'ed.
 */

function quest(over: Partial<FilterableQuest> = {}): FilterableQuest {
  return {
    city: 'Белград',
    price: 890,
    complexity: 'medium',
    age_target: 'everyone',
    tags: ['история'],
    ...over,
  };
}

const facets = (over: Partial<FacetFilters> = {}): FacetFilters => ({ ...EMPTY_FACETS, ...over });

describe('matchesAttrs', () => {
  it('an empty facet matches everything, including null attributes', () => {
    expect(matchesAttrs(EMPTY_FACETS, quest())).toBe(true);
    expect(
      matchesAttrs(EMPTY_FACETS, quest({ city: null, price: null, complexity: null, age_target: null, tags: [] })),
    ).toBe(true);
  });

  it('OR within a facet', () => {
    const f = facets({ complexity: ['low', 'medium'] });
    expect(matchesAttrs(f, quest({ complexity: 'low' }))).toBe(true);
    expect(matchesAttrs(f, quest({ complexity: 'medium' }))).toBe(true);
    expect(matchesAttrs(f, quest({ complexity: 'high' }))).toBe(false);
    expect(matchesAttrs(f, quest({ complexity: null }))).toBe(false);
  });

  it('AND across facets', () => {
    const f = facets({ complexity: ['low'], city: ['Земун'] });
    expect(matchesAttrs(f, quest({ complexity: 'low', city: 'Земун' }))).toBe(true);
    expect(matchesAttrs(f, quest({ complexity: 'low', city: 'Белград' }))).toBe(false);
    expect(matchesAttrs(f, quest({ complexity: 'high', city: 'Земун' }))).toBe(false);
  });

  it('a tag facet matches a quest that carries ANY of the chosen tags', () => {
    const f = facets({ tag: ['еда', 'легенды'] });
    expect(matchesAttrs(f, quest({ tags: ['история', 'еда'] }))).toBe(true);
    expect(matchesAttrs(f, quest({ tags: ['история'] }))).toBe(false);
  });

  it('«Для детей» + «18+» is an empty intersection with a complexity facet', () => {
    const f = facets({ age: ['kids', '18plus'], complexity: ['low'] });
    const list = [
      quest({ age_target: 'kids', complexity: 'high' }),
      quest({ age_target: '18plus', complexity: 'medium' }),
      quest({ age_target: 'everyone', complexity: 'low' }),
    ];
    expect(list.filter((q) => matchesAttrs(f, q))).toHaveLength(0);
  });

  it('price: free is strictly 0, paid is > 0, and null is neither', () => {
    const free = facets({ price: ['free'] });
    const paid = facets({ price: ['paid'] });
    const both = facets({ price: ['free', 'paid'] });
    expect(matchesAttrs(free, quest({ price: 0 }))).toBe(true);
    expect(matchesAttrs(free, quest({ price: 890 }))).toBe(false);
    expect(matchesAttrs(paid, quest({ price: 890 }))).toBe(true);
    expect(matchesAttrs(paid, quest({ price: 0 }))).toBe(false);
    // free + paid together mean «the price is known» — legacy nulls drop out.
    expect(matchesAttrs(both, quest({ price: 0 }))).toBe(true);
    expect(matchesAttrs(both, quest({ price: 890 }))).toBe(true);
    expect(matchesAttrs(both, quest({ price: null }))).toBe(false);
    expect(matchesAttrs(free, quest({ price: null }))).toBe(false);
    expect(matchesAttrs(paid, quest({ price: null }))).toBe(false);
    // …and with no price facet a legacy null still shows up.
    expect(matchesAttrs(EMPTY_FACETS, quest({ price: null }))).toBe(true);
  });

  it('hideOwned drops owned quests only when it is on', () => {
    const on = facets({ hideOwned: true });
    expect(matchesAttrs(on, quest(), true)).toBe(false);
    expect(matchesAttrs(on, quest(), false)).toBe(true);
    expect(matchesAttrs(EMPTY_FACETS, quest(), true)).toBe(true);
  });

  it('a quest without the optional store fields (constructor rows) is unaffected', () => {
    const row: FilterableQuest = { complexity: 'low', age_target: 'kids', tags: ['хоррор'] };
    expect(matchesAttrs(facets({ complexity: ['low'] }), row)).toBe(true);
    expect(matchesAttrs(facets({ city: ['Белград'] }), row)).toBe(false);
    expect(matchesAttrs(facets({ price: ['free'] }), row)).toBe(false);
  });
});

describe('singleValueFacets', () => {
  it('turns the constructor’s single choice into one-element facets, «» into «any»', () => {
    expect(singleValueFacets({ complexity: 'low', age: '', tag: 'хоррор' })).toEqual({
      ...EMPTY_FACETS,
      complexity: ['low'],
      tag: ['хоррор'],
    });
  });

  it('feeds the shared predicate: one chosen value behaves like one chip', () => {
    const f = singleValueFacets({ complexity: '', age: 'kids', tag: '' });
    expect(matchesAttrs(f, quest({ age_target: 'kids' }))).toBe(true);
    expect(matchesAttrs(f, quest({ age_target: 'everyone' }))).toBe(false);
  });
});

describe('countActiveValues', () => {
  it('counts values, not facets', () => {
    expect(countActiveValues(EMPTY_FACETS)).toBe(0);
    expect(countActiveValues(facets({ tag: ['a', 'b', 'c'] }))).toBe(3);
    expect(countActiveValues(facets({ tag: ['a'], city: ['Ниш'], hideOwned: true }))).toBe(3);
  });
});
