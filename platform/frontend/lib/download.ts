/**
 * Bundle download flow: fetch the grant-gated frozen snapshot, store it in the
 * IndexedDB `bundles` store (data), pre-cache referenced media into a named
 * SW Cache `quest-bundle-{snapshot_id}` (assets), and put the quest's player
 * page into the SW shell cache (so it opens offline). Snapshot versions are
 * immutable, so the media cache key never needs invalidation.
 *
 * Storing and precaching are split so both entry points reuse them: the explicit
 * «Скачать для офлайна» button (full, awaited, with progress) and the on-open
 * BundleGate (store now, warm media in the background).
 *
 * Progress is staged (fetch → store → cache) — one JSON fetch has no meaningful
 * byte progress; real sizes arrive with the media phase (P6 measurement item).
 */
import { loadQuestSnapshot, type QuestSnapshot } from './shared-model';
import { mediaRefs } from './snapshot';
import type { BundleWire } from './api';
import {
  deleteBundlesForQuest,
  getActiveAttempt,
  getFacts,
  putBundle,
  setBundleMediaComplete,
  supersedeActiveAttempt,
  type BundleRow,
} from './queue';

export type DownloadStage = 'fetching' | 'storing' | 'caching' | 'done';

/** The service worker's shell cache — `SHELL_CACHE` in public/sw.js, the one its
 *  offline navigation reads. Renaming one without the other breaks offline open. */
const SHELL_CACHE = 'shell-v1';

/** A cross-origin http(s) media ref worth precaching (vs `/`-shell / inline `data:`). */
const isHttpUrl = (ref?: string | null): ref is string => !!ref && /^https?:\/\//.test(ref);

/** The api surface the download needs — injected so tests can stub it. */
export interface DownloadApi {
  getBundle(questId: string, userId: string): Promise<BundleWire>;
}

/**
 * Cross-origin media URLs (served via the API origin / Cloudflare R2) referenced by the
 * snapshot — the ones the service worker's same-origin shell cache can't reach, so they
 * must be explicitly precached for offline play. Same-origin refs are covered by the
 * SW's shell cache; inline `data:` URIs (legacy) live in the snapshot JSON and need no
 * caching. The walk itself lives in lib/snapshot (`mediaRefs` — EVERY media-bearing
 * field) so nothing the player can render is missing offline; this only keeps the
 * cacheability filter.
 */
export function collectMediaRefs(snapshot: QuestSnapshot): string[] {
  return mediaRefs(snapshot).filter(isHttpUrl);
}

/**
 * Cache one media file. A 4xx answer is a file gone for everyone — online play
 * can't show it either, so offline is no worse and nothing is owed; only what a
 * retry could fix (no network, no CORS, a 5xx) counts as a failure.
 */
async function cacheMediaFile(cache: Cache, ref: string): Promise<void> {
  const res = await fetch(ref, { mode: 'cors' });
  if (res.ok) return cache.put(ref, res);
  if (res.status >= 500) throw new Error(`${res.status} ${ref}`);
}

/**
 * Pre-cache media into the bundle's named Cache so offline play has it, and say
 * whether ALL of it made it. The fetch is CORS, so the media host must allow the
 * app origin; failures are logged (not fatal — the JSON still plays online) so a
 * missing CORS config is diagnosable rather than a silent offline gap. Without
 * the Cache API (some private modes) nothing is cached — incomplete, unless
 * there was nothing to cache.
 */
async function precacheMedia(snapshotId: string, refs: string[]): Promise<boolean> {
  if (refs.length === 0) return true;
  if (typeof caches === 'undefined') return false;
  try {
    const cache = await caches.open(`quest-bundle-${snapshotId}`);
    const results = await Promise.allSettled(refs.map((ref) => cacheMediaFile(cache, ref)));
    const failed = results.filter((r) => r.status === 'rejected').length;
    if (failed > 0) {
      console.warn(
        `precacheMedia: ${failed}/${refs.length} media failed to cache for offline ` +
          `(snapshot ${snapshotId}) — cross-origin media needs CORS on the media host.`,
      );
    }
    return failed === 0;
  } catch {
    return false; // Cache API blocked — the bundle still plays online / from IndexedDB
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
    // Not offline-complete until the media precache confirms it.
    media_complete: false,
  };
  await putBundle(row);
  return row;
}

/**
 * Precache all media the bundle references, plus the optional list cover, and
 * record on the stored bundle whether everything made it (the «⭳ офлайн» badge
 * reads that). Best-effort and idempotent — safe to await (explicit download)
 * or fire in the background (on open).
 */
export async function precacheBundleMedia(
  snapshotId: string,
  snapshot: QuestSnapshot,
  coverUrl?: string | null,
): Promise<void> {
  const refs = collectMediaRefs(snapshot);
  const cover = coverUrl?.trim();
  if (isHttpUrl(cover) && !refs.includes(cover)) refs.push(cover);
  const complete = await precacheMedia(snapshotId, refs);
  await setBundleMediaComplete(snapshotId, complete).catch(() => {});
}

/** Same-origin build assets a page names — its script/style tags and the chunk
 *  list inside its RSC payload — so the page can boot with no network. */
export function shellAssetUrls(html: string): string[] {
  const found = html.match(/\/_next\/static\/[^"'\s\\<>()]+?\.(?:js|css|woff2)(?:\?[^"'\s\\<>()]*)?/g) ?? [];
  return [...new Set(found)];
}

/**
 * Put the quest's player page — its HTML and every asset it names — into the
 * service worker's shell cache, so the quest opens offline even on a device that
 * only ever reached it by in-app navigation, which the service worker never sees
 * as a page load (it caches pages only on a real one). Best-effort: online only;
 * a failure leaves the service worker's own cache as the fallback, as before.
 */
export async function precachePlayerPage(questId: string): Promise<void> {
  if (typeof caches === 'undefined' || typeof window === 'undefined') return;
  try {
    const url = new URL(`/quest/${encodeURIComponent(questId)}`, window.location.origin).href;
    const res = await fetch(url, { credentials: 'same-origin' });
    if (!res.ok) return;
    const html = await res.clone().text();
    const cache = await caches.open(SHELL_CACHE);
    await cache.put(url, res);
    await Promise.allSettled(
      shellAssetUrls(html).map(async (asset) => {
        if (!(await cache.match(asset))) await cache.add(asset);
      }),
    );
  } catch {
    // offline or Cache API blocked — nothing to warm
  }
}

/** Download and persist a quest bundle (snapshot + media + cover + player page). Returns the stored row. */
export async function downloadBundle(
  questId: string,
  userId: string,
  api: DownloadApi,
  onStage?: (stage: DownloadStage) => void,
): Promise<BundleRow> {
  onStage?.('fetching');
  const wire = await api.getBundle(questId, userId);

  onStage?.('storing');
  const row = await storeBundle(wire);

  onStage?.('caching');
  await Promise.all([
    precacheBundleMedia(row.snapshot_id, row.snapshot, wire.primary_comic),
    precachePlayerPage(questId),
  ]);

  onStage?.('done');
  return row;
}

/** Why a downloaded quest can't be removed right now, or null when it can. */
export type RemoveBlock = 'in-progress';

/**
 * Removal is refused while an attempt is running. The attempt is frozen on the
 * version it was started on, and the server serves only the latest one: delete
 * the download and a later update would slip under the running attempt.
 */
export async function removeBlock(questId: string): Promise<RemoveBlock | null> {
  const attempt = await getActiveAttempt(questId);
  if (!attempt) return null;
  const facts = (await getFacts(attempt.attempt_key)).map((r) => r.fact);
  const empty = facts.length === 0 && attempt.last_step_idx === 0;
  return empty || facts.some((f) => f.type === 'attempt_completed') ? null : 'in-progress';
}

/**
 * «Удалить с устройства»: every downloaded version of the quest and its media.
 * The player page stays cached — it is small and shared by future downloads.
 * An active attempt that is empty or finished is retired with it: it is bound
 * to the version being removed, and the next open must bind afresh to the
 * version it can actually fetch. Its facts stay, like any superseded attempt's,
 * so coins and the finish are kept (lib/owned-quests reads the finish back).
 */
export async function removeDownloadedQuest(questId: string): Promise<void> {
  if ((await removeBlock(questId)) !== null) {
    throw new Error(`quest ${questId} is in progress — its download pins the running attempt`);
  }
  await supersedeActiveAttempt(questId);
  const ids = await deleteBundlesForQuest(questId);
  if (typeof caches === 'undefined') return;
  await Promise.all(ids.map((id) => caches.delete(`quest-bundle-${id}`).catch(() => false)));
}
