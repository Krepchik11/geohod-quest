import type { Metadata } from 'next';
import SiteShell from '../../../components/SiteShell';
import { questShareMetadata } from '../../share-metadata';
import AboutClient from './AboutClient';

/**
 * §5: the product page links the per-quest manifest — the owned-state install
 * button prompts for THIS quest's app, not the global one — and carries the
 * quest's own share card, because THIS is the URL people paste.
 */
export async function generateMetadata({
  params,
}: {
  params: Promise<{ questId: string }>;
}): Promise<Metadata> {
  const { questId } = await params;
  return questShareMetadata(questId);
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
