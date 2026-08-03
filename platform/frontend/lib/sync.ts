/**
 * Flush controller — moves pending facts from the IndexedDB queue to the server.
 *
 * Owns the attempt-registration handshake (client attempt_key → server_attempt_id,
 * with the checkout-on-refusal fallback) and the single-flight guarantee, now keyed
 * by attempt_key (the unit that maps 1:1 to a server attempt): the `online` event,
 * app start, the manual button, and the whole-device sweep can all fire concurrently,
 * and two concurrent registrations would create two server attempts (POST /api/attempts
 * is not idempotent). Concurrent callers for the same attempt therefore share one
 * in-flight flush.
 *
 * Two entry points share that core:
 *  - flushPending(questId): the active attempt only — used by the player, returns the
 *    FlushResult so it can derive the SPEC sync corrections.
 *  - flushAll(): every attempt on the device incl. superseded ones — used on app/
 *    profile load to drain facts that were never synced (completion stranded on an
 *    attempt that was replaced by «Начать заново», or appended after the last flush).
 *
 * Corrections stay out of here on purpose: the component derives the two SPEC
 * notices via deriveSyncCorrections(localBefore, authoritative) — no stored
 * correction facts exist anywhere.
 */
import type { Fact, ProjectedState } from './shared-model';
import { projectState } from './shared-model';
import {
  getActiveAttempt,
  getAttempt,
  getFacts,
  getPendingFacts,
  listAttempts,
  markSent,
  setServerAttemptId,
  type AttemptRow,
} from './queue';

/** The api surface the flush needs — injected so tests can stub it. */
export interface SyncApi {
  createAttempt(body: { user_id: string; quest_id: string }): Promise<{ attempt_id: string; snapshot_id: string }>;
  checkout(body: { user_id: string; quest_id: string }): Promise<unknown>;
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

/** Single-flight keyed by attempt_key — see module doc. */
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
  body: { user_id: string; quest_id: string },
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
 * Flush ONE attempt's pending facts to the server. Returns null when nothing is
 * pending; rejects (leaving everything pending) on failure. Single-flight by
 * attempt_key so the player's flush, the back-online flush and the whole-device
 * sweep never double-register the same attempt.
 *
 * `server_attempt_id` is re-read inside the flight (not trusted from the passed
 * row), so a row snapshot taken before a prior flush bound the id can never cause
 * a duplicate registration.
 */
function flushAttempt(attempt: AttemptRow, userId: string, api: SyncApi): Promise<FlushResult | null> {
  const existing = inflight.get(attempt.attempt_key);
  if (existing) return existing;

  const run = (async (): Promise<FlushResult | null> => {
    const pending = await getPendingFacts(attempt.attempt_key);
    if (pending.length === 0) return null;

    const localBefore = projectState((await getFacts(attempt.attempt_key)).map((r) => r.fact));
    const body = { user_id: userId, quest_id: attempt.quest_id };
    const boundId = (await getAttempt(attempt.attempt_key))?.server_attempt_id;
    const serverId = await ensureRegistered(attempt.attempt_key, body, api, boundId);

    const resp = (await api.appendFacts(serverId, pending.map((r) => r.fact))) as AppendFactsResponse;
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
  })().finally(() => inflight.delete(attempt.attempt_key));

  inflight.set(attempt.attempt_key, run);
  return run;
}

/**
 * Flush the active attempt's pending facts. Returns null when there is no
 * attempt or nothing pending; rejects (leaving everything pending) on failure.
 * Concurrent calls for the same quest share one flush and one result.
 */
export async function flushPending(opts: {
  questId: string;
  userId: string;
  api: SyncApi;
}): Promise<FlushResult | null> {
  const attempt = await getActiveAttempt(opts.questId);
  if (!attempt) return null;
  return flushAttempt(attempt, opts.userId, opts.api);
}

/**
 * Drain EVERY attempt on the device — active and superseded — that still has
 * pending facts. Best-effort: one attempt's failure (no grant recoverable,
 * offline, etc.) is swallowed so the rest still sync. This is what makes the
 * profile reflect reality: a completion that never synced (because nothing
 * triggered a flush after it, or because «Начать заново» superseded its attempt
 * first) is recovered here on the next online app/profile load, under whatever
 * identity is current (anonymous device id, or the account that adopted it after
 * registration). Idempotent — already-sent facts and the once-per-quest
 * completion bonus are absorbed server-side on replay.
 */
export async function flushAll(opts: { userId: string; api: SyncApi }): Promise<void> {
  const attempts = await listAttempts();
  await Promise.all(
    attempts.map((a) => flushAttempt(a, opts.userId, opts.api).catch(() => null))
  );
}
