/**
 * Bundle download flow: fetch the grant-gated frozen snapshot, store it in the
 * IndexedDB `bundles` store (data), pre-cache referenced media into a named
 * SW Cache `quest-bundle-{snapshot_id}` (assets). Snapshot versions are
 * immutable, so the cache key never needs invalidation.
 *
 * Progress is staged (fetch → store → cache) — one JSON fetch has no meaningful
 * byte progress; real sizes arrive with the media phase (P6 measurement item).
 */
import type { QuestSnapshot } from './shared-model';
import { putBundle, type BundleRow } from './queue';

export type DownloadStage = 'fetching' | 'storing' | 'caching' | 'done';

/** The api surface the download needs — injected so tests can stub it. */
export interface DownloadApi {
  getBundle(
    questId: string,
    playerId: string
  ): Promise<{ quest_id: string; snapshot_id: string; snapshot_version: number; snapshot: unknown }>;
}

/** Same-origin media refs present in the snapshot (today: demo image paths). */
export function collectMediaRefs(snapshot: QuestSnapshot): string[] {
  const refs = new Set<string>();
  for (const step of snapshot.steps) {
    for (const ref of [step.media?.task, step.media?.character, step.media?.hint, step.media?.atmosphere]) {
      if (ref && ref.startsWith('/')) refs.add(ref);
    }
  }
  return [...refs];
}

/** Pre-cache media into the bundle's named Cache; absent Cache API is a no-op. */
async function precacheMedia(snapshotId: string, refs: string[]): Promise<void> {
  if (typeof caches === 'undefined' || refs.length === 0) return;
  try {
    const cache = await caches.open(`quest-bundle-${snapshotId}`);
    // Settled, not all: one missing demo asset must not fail the download.
    await Promise.allSettled(refs.map((ref) => cache.add(ref)));
  } catch {
    // Cache API unavailable (private mode etc.) — bundle still plays from IndexedDB.
  }
}

/** Download and persist a quest bundle. Returns the stored row. */
export async function downloadBundle(
  questId: string,
  playerId: string,
  api: DownloadApi,
  onStage?: (stage: DownloadStage) => void
): Promise<BundleRow> {
  onStage?.('fetching');
  const wire = await api.getBundle(questId, playerId);
  const snapshot = wire.snapshot as QuestSnapshot;

  onStage?.('storing');
  const row: BundleRow = {
    snapshot_id: wire.snapshot_id,
    quest_id: wire.quest_id,
    version: wire.snapshot_version,
    snapshot,
    size_bytes: new Blob([JSON.stringify(snapshot)]).size,
    downloaded_at: new Date().toISOString(),
  };
  await putBundle(row);

  onStage?.('caching');
  await precacheMedia(wire.snapshot_id, collectMediaRefs(snapshot));

  onStage?.('done');
  return row;
}
