/**
 * Goldens loader (shared fixtures live at platform/goldens/ — single source for both
 * the Rust and TypeScript suites; see goldens/README.md).
 * Traceability: mapped from the original Bubble quest exports.
 * Use load* from shared-model + these for tests.
 */
import mysterySnapshot from '../../goldens/golden-mystery-fortress-v1.json';
import ironiaSnapshot from '../../goldens/golden-ironia-sudby-v1.json';
import happyPlaythrough from '../../goldens/playthrough-happy-with-gift.json';

import { loadQuestSnapshot, loadPlaythroughGolden, QuestSnapshot, PlaythroughGolden } from './shared-model';

export const GOLDENS = {
  snapshots: {
    'mystery-fortress-v1': loadQuestSnapshot(mysterySnapshot),
    'ironia-sudby': loadQuestSnapshot(ironiaSnapshot),
  } as Record<string, QuestSnapshot>,
  playthroughs: {
    'happy-with-gift': loadPlaythroughGolden(happyPlaythrough),
  } as Record<string, PlaythroughGolden>,
};

// Accessors (no dups)
export function getSnapshot(id: string): QuestSnapshot {
  const s = GOLDENS.snapshots[id];
  if (!s) throw new Error(`Unknown snapshot golden: ${id}`);
  return s;
}

export function getPlaythrough(id: string): PlaythroughGolden {
  const p = GOLDENS.playthroughs[id];
  if (!p) throw new Error(`Unknown playthrough golden: ${id}`);
  return p;
}