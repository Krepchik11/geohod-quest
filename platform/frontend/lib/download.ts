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

/**
 * Cross-origin media URLs (Cloudflare R2) referenced by the snapshot — the ones the
 * service worker's same-origin shell cache can't reach, so they must be explicitly
 * precached for offline play. Same-origin refs are covered by the SW's shell cache;
 * inline `data:` URIs (legacy) live in the snapshot JSON and need no caching.
 */
export function collectMediaRefs(snapshot: QuestSnapshot): string[] {
  const refs = new Set<string>();
  for (const step of snapshot.steps) {
    for (const ref of [step.media?.task, step.media?.character, step.media?.hint, step.media?.atmosphere]) {
      if (ref && /^https?:\/\//.test(ref)) refs.add(ref);
    }
  }
  return [...refs];
}

/**
 * Pre-cache media into the bundle's named Cache so offline play has it. `cache.add`
 * issues a CORS fetch, so the media host (R2) must allow the app origin via CORS;
 * failures are logged (not fatal — the JSON still plays online) so a missing CORS
 * config is diagnosable rather than a silent offline gap. Absent Cache API (private
 * mode) is a no-op.
 */
async function precacheMedia(snapshotId: string, refs: string[]): Promise<void> {
  if (typeof caches === 'undefined' || refs.length === 0) return;
  try {
    const cache = await caches.open(`quest-bundle-${snapshotId}`);
    const results = await Promise.allSettled(refs.map((ref) => cache.add(ref)));
    const failed = results.filter((r) => r.status === 'rejected').length;
    if (failed > 0) {
      console.warn(
        `precacheMedia: ${failed}/${refs.length} media failed to cache for offline ` +
          `(snapshot ${snapshotId}) — cross-origin media needs CORS on the media host.`,
      );
    }
  } catch {
    // Cache API unavailable (private mode etc.) — bundle still plays online / from IndexedDB.
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
