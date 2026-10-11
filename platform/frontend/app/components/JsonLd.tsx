import React from 'react';
import { jsonLdText } from '../../lib/seo';

/** schema.org structured data for crawlers (lib/seo.ts builds it). */
export default function JsonLd({ data }: { data: Record<string, unknown> }) {
  return <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLdText(data) }} />;
}
