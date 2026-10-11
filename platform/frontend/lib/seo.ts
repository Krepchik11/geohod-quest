/**
 * Structured data (schema.org JSON-LD) for search engines and AI crawlers:
 * they read it from the server-rendered HTML without running the app's
 * JavaScript. Pure builders; the `<script>` is app/components/JsonLd.tsx.
 */

import type { ProductPageWire } from './generated';
import { CLUB_CHANNEL_URL, SUPPORT_TG_URL } from './contacts';
import { questShareUrl, siteUrl } from './share';

/** A JSON-LD object as the text of its `<script>`: `<` escaped, so no payload closes the tag. */
export function jsonLdText(data: Record<string, unknown>): string {
  return JSON.stringify(data).replace(/</g, '\\u003c');
}

/** The brand behind the site, with its Telegram presence. */
export function organizationJsonLd(): Record<string, unknown> {
  return {
    '@context': 'https://schema.org',
    '@type': 'Organization',
    name: 'GEOHOD QUEST',
    url: siteUrl(),
    logo: `${siteUrl()}/icon-512.png`,
    sameAs: [CLUB_CHANNEL_URL, SUPPORT_TG_URL],
  };
}

/** A quest's product page: name, description, price in rubles and its rating. */
export function productJsonLd(product: ProductPageWire): Record<string, unknown> {
  const url = questShareUrl(product.quest_id);
  return {
    '@context': 'https://schema.org',
    '@type': 'Product',
    name: product.name,
    description: product.description?.trim() || undefined,
    category: 'Городской квест',
    brand: { '@type': 'Brand', name: 'GEOHOD QUEST' },
    image: `${url}/opengraph-image?v=${product.snapshot_version}`,
    url,
    offers: {
      '@type': 'Offer',
      price: product.price ?? 0,
      priceCurrency: 'RUB',
      availability: 'https://schema.org/InStock',
      url,
    },
    aggregateRating:
      product.rating_count > 0
        ? {
            '@type': 'AggregateRating',
            ratingValue: Math.round(product.rating_avg * 10) / 10,
            ratingCount: product.rating_count,
            bestRating: 5,
          }
        : undefined,
  };
}
