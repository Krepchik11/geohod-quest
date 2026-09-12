import type { Viewport } from 'next';
import BundleGate from '../BundleGate';
import { fetchQuest, questShareMetadata } from '../share-metadata';
import { parseTheme, themeVars, type QuestTheme } from '../../../lib/quest-theme';

// The paper frame is 30 KB of CSS that only the player renders. Imported on the
// player route itself — not in a `app/quest/layout.tsx`, which would also hand
// it to the product page at /quest/[questId]/about, which draws none of it.
import '../../styles/player-paper.css';

// Scoped to the player route. The frame fills the dynamic viewport, so ask the
// browser to RESIZE the layout (not just the visual viewport) when the on-screen
// keyboard opens — a focused answer field then scrolls into view above the
// keyboard. Honored on Android Chrome; iOS keeps its visual-viewport behavior,
// which the non-sticky answer action bar (.p-actions--field) already accommodates.
/** §5: the player links the per-quest manifest so installs scope to this quest,
 *  and wears the quest's own card — an owner shares this URL too. */
export async function generateMetadata({ params }: { params: Promise<{ questId: string }> }) {
  const { questId } = await params;
  return questShareMetadata(questId);
}

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  interactiveWidget: 'resizes-content',
  // Standalone installs draw under the status bar; safe-area env() insets in
  // player-paper.css only take effect with viewport-fit=cover.
  viewportFit: 'cover',
};

// RSC shell: full-bleed paper page, no site chrome — the player IS the page.
// All resolution (bundle → server, access enforcement) happens in BundleGate.
export default async function QuestPage({
  params,
}: {
  params: Promise<{ questId: string }>;
}) {
  const { questId } = await params;
  // Full-bleed shell — centers the player on desktop, full viewport on phones.
  // Responsive rules live in styles/player-paper.css (.player-shell).
  //
  // The quest's colours are put on the SHELL, server-side: everything inside it
  // inherits them, so the loading and access gates, the letterbox around the
  // frame and the overscroll area are already the quest's own background in the
  // first HTML — no flash of the default palette before the bundle resolves.
  return (
    <main className="player-shell" style={themeVars(await questTheme(questId))}>
      <BundleGate questId={questId} />
    </main>
  );
}

/** The published quest's colours, or null (unpublished, offline, no colours). */
async function questTheme(questId: string): Promise<QuestTheme | null> {
  const quest = await fetchQuest(questId);
  return quest ? parseTheme(quest.theme) : null;
}
