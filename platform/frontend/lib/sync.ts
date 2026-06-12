/**
 * Flush controller — moves pending facts from the IndexedDB queue to the server.
 *
 * Owns the attempt-registration handshake (client attempt_key → server_attempt_id,
 * with the checkout-on-refusal fallback) and the single-flight guarantee: the
 * `online` event, app start, and the manual button can all fire concurrently, and
 * two concurrent registrations would create two server attempts (POST /api/attempts
 * is not idempotent). Concurrent callers therefore share one in-flight flush.
 *
 * Corrections stay out of here on purpose: the component derives the two SPEC
 * notices via deriveSyncCorrections(localBefore, authoritative) — no stored
 * correction facts exist anywhere.
 */
import type { Fact, ProjectedState } from './shared-model';
import { projectState } from './shared-model';
import { getActiveAttempt, getFacts, getPendingFacts, markSent, setServerAttemptId } from './queue';

/** The api surface the flush needs — injected so tests can stub it. */
export interface SyncApi {
  createAttempt(body: { player_id: string; quest_id: string }): Promise<{ attempt_id: string; snapshot_id: string }>;
  checkout(body: { player_id: string; quest_id: string }): Promise<unknown>;
  appendFacts(attemptId: string, facts: Fact[]): Promise<unknown>;
}

export interface FlushResult {
  /** How many pending facts were posted. */
  flushed: number;
  /** Projection over the full local log before the flush (corrections input). */
  localBefore: ProjectedState;
  /** The server's authoritative projection from the POST response. */
  authoritative: ProjectedState;
}

/** Wire shape of the facts POST response (snake_case per backend). */
interface AppendFactsResponse {
  projected: { balance: number; completed_steps: number[]; revealed_hints: number[] };
}

const inflight = new Map<string, Promise<FlushResult | null>>();

/** Test hook: forget in-flight flushes. */
export function __resetSyncForTests(): void {
  inflight.clear();
}

/**
 * Resolve the server attempt id for a local attempt, registering it on first need.
 * Refusal (e.g. 403 no grant) falls back to checkout once, then retries — the
 * existing player behavior, now persisted so it happens at most once per attempt.
 */
async function ensureRegistered(
  attemptKey: string,
  body: { player_id: string; quest_id: string },
  api: SyncApi,
  boundId: string | undefined
): Promise<string> {
  if (boundId) return boundId;
  let meta: { attempt_id: string };
  try {
    meta = await api.createAttempt(body);
  } catch {
    await api.checkout(body);
    meta = await api.createAttempt(body);
  }
  await setServerAttemptId(attemptKey, meta.attempt_id);
  return meta.attempt_id;
}

/**
 * Flush the active attempt's pending facts. Returns null when there is no
 * attempt or nothing pending; rejects (leaving everything pending) on failure.
 * Concurrent calls for the same quest share one flush and one result.
 */
export function flushPending(opts: { questId: string; playerId: string; api: SyncApi }): Promise<FlushResult | null> {
  const existing = inflight.get(opts.questId);
  if (existing) return existing;

  const run = (async (): Promise<FlushResult | null> => {
    const attempt = await getActiveAttempt(opts.questId);
    if (!attempt) return null;
    const pending = await getPendingFacts(attempt.attempt_key);
    if (pending.length === 0) return null;

    const localBefore = projectState((await getFacts(attempt.attempt_key)).map((r) => r.fact));
    const body = { player_id: opts.playerId, quest_id: opts.questId };
    const serverId = await ensureRegistered(attempt.attempt_key, body, opts.api, attempt.server_attempt_id);

    const resp = (await opts.api.appendFacts(serverId, pending.map((r) => r.fact))) as AppendFactsResponse;
    // A successful POST means every fact in the batch is on the server.
    await markSent(attempt.attempt_key, pending.map((r) => r.key));

    return {
      flushed: pending.length,
      localBefore,
      authoritative: {
        balance: resp.projected.balance,
        completedSteps: resp.projected.completed_steps,
        revealedHints: resp.projected.revealed_hints,
      },
    };
  })().finally(() => inflight.delete(opts.questId));

  inflight.set(opts.questId, run);
  return run;
}
