import type { Metadata } from 'next';
import SiteShell from '../../../components/SiteShell';
import { API_BASE, type ProductPageWire } from '../../../../lib/api';
import { questShareUrl } from '../../../../lib/share';
import AboutClient from './AboutClient';

/** Fallback description when the author left the store description blank. */
function fallbackDescription(p: ProductPageWire): string {
  const parts = [p.city, p.duration].filter(Boolean);
  return parts.length
    ? `Городской квест в GEOHOD QUEST — ${parts.join(' · ')}.`
    : 'Городской квест в GEOHOD QUEST.';
}

/**
 * §5: the product page links the per-quest manifest — the owned-state install
 * button prompts for THIS quest's app, not the global one.
 *
 * §share: it also carries the Open Graph tags, because this page IS what a
 * shared link opens. The card data comes from the same request (and the same
 * TTL) the manifest route uses; a failure degrades to the generic tags rather
 * than failing the page, which loads its own data client-side anyway.
 */
export async function generateMetadata({
  params,
}: {
  params: Promise<{ questId: string }>;
}): Promise<Metadata> {
  const { questId } = await params;
  const manifest = `/quest/${encodeURIComponent(questId)}/manifest.webmanifest`;

  const res = await fetch(`${API_BASE}/api/quests/${encodeURIComponent(questId)}`, {
    next: { revalidate: 300 },
  }).catch(() => null);
  if (!res || !res.ok) {
    return { title: 'О квесте — GEOHOD QUEST', manifest };
  }
  const p = (await res.json()) as ProductPageWire;
  const title = `${p.name} — GEOHOD QUEST`;
  const description = p.description?.trim() || fallbackDescription(p);
  const url = questShareUrl(questId);

  return {
    title,
    description,
    manifest,
    openGraph: {
      type: 'website',
      siteName: 'GEOHOD QUEST',
      locale: 'ru_RU',
      title,
      description,
      url,
      // Root-relative; `metadataBase` in the root layout absolutizes it.
      // Naming the image here overrides the `opengraph-image.tsx` file
      // convention's own URL on purpose, so the version is OURS: messengers
      // cache an OG image hard and by URL, and a republished cover needs a
      // new one to ever be seen.
      images: [
        {
          url: `/quest/${encodeURIComponent(questId)}/about/opengraph-image?v=${p.snapshot_version}`,
          width: 1200,
          height: 630,
          alt: p.name,
        },
      ],
    },
    twitter: { card: 'summary_large_image', title, description },
  };
}

/**
 * §3.1 — the quest product page: /quest/[id]/about. The PLAYER stays at
 * /quest/[id]; this page is the storefront face of one quest (model data only)
 * with the order card and the confirmation-sheet purchase flow. RSC shell is
 * thin: the payload is identity-aware (owned state), so data loads client-side
 * like the rest of the storefront.
 */
export default async function QuestAboutPage({
  params,
}: {
  params: Promise<{ questId: string }>;
}) {
  const { questId } = await params;
  return (
    <SiteShell>
      <AboutClient questId={questId} />
    </SiteShell>
  );
}
