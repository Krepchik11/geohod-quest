import { describe, expect, it } from 'vitest';
import type { ProductPageWire } from '../generated';
import { jsonLdText, organizationJsonLd, productJsonLd } from '../seo';

const product = (over: Partial<ProductPageWire> = {}): ProductPageWire =>
  ({
    quest_id: 'q1',
    name: 'Тайна крепости',
    description: '  Квест по Петроварадину. ',
    price: 490,
    rating_avg: 4.86,
    rating_count: 7,
    snapshot_version: 3,
    ...over,
  }) as ProductPageWire;

describe('structured data', () => {
  it('escapes «<» so no payload can close the script tag', () => {
    expect(jsonLdText({ name: '</script><b>' })).toBe('{"name":"\\u003c/script>\\u003cb>"}');
  });

  it('names the brand and its Telegram channels', () => {
    const ld = organizationJsonLd();
    expect(ld['@type']).toBe('Organization');
    expect(ld.sameAs).toEqual(['https://t.me/serbia_progulki', 'https://t.me/geohod']);
  });

  it('describes a quest as a product with its price in rubles and its rating', () => {
    const ld = productJsonLd(product());
    expect(ld.name).toBe('Тайна крепости');
    expect(ld.description).toBe('Квест по Петроварадину.');
    expect(ld.offers).toMatchObject({ price: 490, priceCurrency: 'RUB' });
    expect(ld.aggregateRating).toMatchObject({ ratingValue: 4.9, ratingCount: 7 });
    expect(String(ld.image)).toMatch(/\/quest\/q1\/about\/opengraph-image\?v=3$/);
  });

  it('leaves out a rating nobody gave and prices a free quest at zero', () => {
    const ld = productJsonLd(product({ rating_count: 0, price: null, description: null }));
    expect(ld.aggregateRating).toBeUndefined();
    expect(ld.description).toBeUndefined();
    expect(ld.offers).toMatchObject({ price: 0 });
  });
});
