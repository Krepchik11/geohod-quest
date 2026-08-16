/**
 * Gate resolution — decides which snapshot a quest opens on, kept separate from
 * the React gate that renders the decision (BundleGate).
 *
 * The rule that matters:
 *  - RESUME an in-progress attempt on its OWN bound snapshot (version freeze) —
 *    a published update must never swap the content under a running attempt.
 *  - RESTART is a fresh run, so it adopts the LATEST published snapshot from the
 *    server. Without this a player who restarts keeps replaying the version they
 *    first downloaded, because the device still holds an active attempt + cached
 *    bundle frozen to the old version. Offline, restart falls back to the latest
 *    bundle already on the device so replay still works.
 *
 * Network is injected (`ResolverDeps`) so the whole matrix is unit-testable; the
 * IndexedDB queue is used directly.
 */
import { classify } from './api';
import type { QuestSnapshot } from './shared-model';
import { loadQuestSnapshot } from './shared-model';
import {
  getActiveAttempt,
  getBundle as getLocalBundle,
  getLatestBundleForQuest,
  restartAttempt,
} from './queue';

export type GateResolution =
  | { kind: 'ready'; snapshot: QuestSnapshot; snapshotId: string }
  | { kind: 'denied' }
  | { kind: 'login-required' }
  | { kind: 'unavailable'; offline: boolean };

/** The bundle envelope the resolver needs from `GET /api/quests/{id}/bundle`. */
export interface FetchedBundle {
  quest_id: string;
  snapshot_id: string;
  snapshot_version: number;
  primary_comic: string | null;
  snapshot: unknown;
}

export interface ResolverDeps {
  userId: string;
  online: boolean;
  /** Latest published bundle for the quest (grant-gated; rejects with ApiError). */
  getBundle: (questId: string, userId: string) => Promise<FetchedBundle>;
  /** Persist + precache a freshly fetched bundle. Best-effort; must resolve even on failure. */
  persist: (wire: FetchedBundle) => Promise<void>;
}

function classifyError(err: unknown, online: boolean): GateResolution {
  const failure = classify(err);
  if (failure.kind === 'forbidden') return { kind: 'denied' };
  if (failure.kind === 'unauthorized') return { kind: 'login-required' };
  return { kind: 'unavailable', offline: !online };
}

export async function resolveGate(
  questId: string,
  restart: boolean,
  deps: ResolverDeps,
): Promise<GateResolution> {
  return restart ? resolveRestart(questId, deps) : resolveResume(questId, deps);
}

/** Fresh run: adopt the latest published version, downloading it if needed. */
async function resolveRestart(questId: string, deps: ResolverDeps): Promise<GateResolution> {
  try {
    const wire = await deps.getBundle(questId, deps.userId);
    const snapshot = loadQuestSnapshot(wire.snapshot);
    // Store the freshly-published bundle before binding the attempt, so a later
    // offline reopen resolves to it. Best-effort — a persist failure never blocks play.
    await deps.persist(wire).catch(() => {});
    await restartAttempt(questId, wire.snapshot_id);
    return { kind: 'ready', snapshot, snapshotId: wire.snapshot_id };
  } catch (err) {
    // Offline / unreachable: restart on the newest bundle already downloaded.
    const latest = await getLatestBundleForQuest(questId).catch(() => null);
    if (latest) {
      await restartAttempt(questId, latest.snapshot_id).catch(() => {});
      return { kind: 'ready', snapshot: latest.snapshot, snapshotId: latest.snapshot_id };
    }
    return classifyError(err, deps.online);
  }
}

/** Resume: an in-progress attempt keeps its bound snapshot (version freeze). */
async function resolveResume(questId: string, deps: ResolverDeps): Promise<GateResolution> {
  try {
    const attempt = await getActiveAttempt(questId);
    const bundle =
      (attempt && (await getLocalBundle(attempt.snapshot_id))) || (await getLatestBundleForQuest(questId));
    if (bundle) return { kind: 'ready', snapshot: bundle.snapshot, snapshotId: bundle.snapshot_id };
  } catch {
    // IndexedDB unavailable — fall through to the network path.
  }
  try {
    const wire = await deps.getBundle(questId, deps.userId);
    const snapshot = loadQuestSnapshot(wire.snapshot);
    void deps.persist(wire).catch(() => {});
    return { kind: 'ready', snapshot, snapshotId: wire.snapshot_id };
  } catch (err) {
    return classifyError(err, deps.online);
  }
}
