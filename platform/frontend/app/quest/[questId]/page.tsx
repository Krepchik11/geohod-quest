import type { Viewport } from 'next';
import BundleGate from '../BundleGate';

// Scoped to the player route. The frame fills the dynamic viewport, so ask the
// browser to RESIZE the layout (not just the visual viewport) when the on-screen
// keyboard opens — a focused answer field then scrolls into view above the
// keyboard. Honored on Android Chrome; iOS keeps its visual-viewport behavior,
// which the non-sticky answer action bar (.p-actions--field) already accommodates.
/** §5: the player links the per-quest manifest so installs scope to this quest. */
export async function generateMetadata({ params }: { params: Promise<{ questId: string }> }) {
  const { questId } = await params;
  return { manifest: `/quest/${encodeURIComponent(questId)}/manifest.webmanifest` };
}

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  interactiveWidget: 'resizes-content',
};

// RSC shell: full-bleed paper page, no site chrome — the player IS the page.
// All resolution (bundle → server, access enforcement) happens in BundleGate.
export default async function QuestPage({
  params,
}: {
  params: Promise<{ questId: string }>;
}) {
  const { questId } = await params;
  // Full-bleed paper shell — centers the player on desktop, full viewport on
  // phones. Responsive rules live in styles/player-paper.css (.player-shell).
  return (
    <main className="player-shell">
      <BundleGate questId={questId} />
    </main>
  );
}
