/**
 * Bundle download flow: fetch the grant-gated frozen snapshot, store it in the
 * IndexedDB `bundles` store (data), pre-cache referenced media into a named
 * SW Cache `quest-bundle-{snapshot_id}` (assets). Snapshot versions are
 * immutable, so the cache key never needs invalidation.
 *
 * Storing and precaching are split so both entry points reuse them: the explicit
 * «Скачать для офлайна» button (full, awaited, with progress) and the on-open
 * BundleGate (store now, warm media in the background).
 *
 * Progress is staged (fetch → store → cache) — one JSON fetch has no meaningful
 * byte progress; real sizes arrive with the media phase (P6 measurement item).
 */
import { loadQuestSnapshot, type QuestSnapshot } from './shared-model';
import type { BundleWire } from './api';
import { putBundle, type BundleRow } from './queue';

export type DownloadStage = 'fetching' | 'storing' | 'caching' | 'done';

/** A cross-origin http(s) media ref worth precaching (vs `/`-shell / inline `data:`). */
const isHttpUrl = (ref?: string | null): ref is string => !!ref && /^https?:\/\//.test(ref);

/** The api surface the download needs — injected so tests can stub it. */
export interface DownloadApi {
  getBundle(questId: string, playerId: string): Promise<BundleWire>;
}

/**
 * Cross-origin media URLs (served via the API origin / Cloudflare R2) referenced by the
 * snapshot — the ones the service worker's same-origin shell cache can't reach, so they
 * must be explicitly precached for offline play. Same-origin refs are covered by the
 * SW's shell cache; inline `data:` URIs (legacy) live in the snapshot JSON and need no
 * caching. Walks EVERY media-bearing field (image roles, video, inline media_video,
 * bonus animation + voice) so nothing the player can render is missing offline.
 */
export function collectMediaRefs(snapshot: QuestSnapshot): string[] {
  const refs = new Set<string>();
  const add = (ref?: string | null) => {
    if (isHttpUrl(ref)) refs.add(ref);
  };
  for (const step of snapshot.steps) {
    const m = step.media;
    add(m?.task);
    add(m?.character);
    add(m?.hint);
    add(m?.atmosphere);
    add(m?.video?.ref);
    const sup = step.supporting;
    add(sup?.media_video);
    add(sup?.bonus_animation?.asset_ref);
    add(sup?.bonus_animation?.voice_ref);
  }
  return [...refs];
}

/**
 * Pre-cache media into the bundle's named Cache so offline play has it. `cache.add`
 * issues a CORS fetch, so the media host must allow the app origin via CORS; failures
 * are logged (not fatal — the JSON still plays online) so a missing CORS config is
 * diagnosable rather than a silent offline gap. Absent Cache API (private mode) is a no-op.
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

/** Validate + persist the snapshot JSON into the `bundles` store, returning the stored row. */
export async function storeBundle(wire: BundleWire): Promise<BundleRow> {
  const snapshot = loadQuestSnapshot(wire.snapshot);
  const row: BundleRow = {
    snapshot_id: wire.snapshot_id,
    quest_id: wire.quest_id,
    version: wire.snapshot_version,
    snapshot,
    size_bytes: new Blob([JSON.stringify(snapshot)]).size,
    downloaded_at: new Date().toISOString(),
  };
  await putBundle(row);
  return row;
}

/**
 * Precache all media the bundle references, plus the optional list cover. Best-effort
 * and idempotent — safe to await (explicit download) or fire in the background (on open).
 */
export async function precacheBundleMedia(
  snapshotId: string,
  snapshot: QuestSnapshot,
  coverUrl?: string | null,
): Promise<void> {
  const refs = collectMediaRefs(snapshot);
  const cover = coverUrl?.trim();
  if (isHttpUrl(cover) && !refs.includes(cover)) refs.push(cover);
  await precacheMedia(snapshotId, refs);
}

/** Download and persist a quest bundle (snapshot + media + cover). Returns the stored row. */
export async function downloadBundle(
  questId: string,
  playerId: string,
  api: DownloadApi,
  onStage?: (stage: DownloadStage) => void,
): Promise<BundleRow> {
  onStage?.('fetching');
  const wire = await api.getBundle(questId, playerId);

  onStage?.('storing');
  const row = await storeBundle(wire);

  onStage?.('caching');
  await precacheBundleMedia(row.snapshot_id, row.snapshot, wire.primary_comic);

  onStage?.('done');
  return row;
}
