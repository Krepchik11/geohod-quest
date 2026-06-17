/**
 * TDD for lib/sync.ts — the flush controller (queue → server, single-flight).
 */
import 'fake-indexeddb/auto';
import { describe, expect, it, beforeEach, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import type { Fact } from '../shared-model';
import {
  ensureActiveAttempt,
  appendFact,
  getFacts,
  getPendingFacts,
  getActiveAttempt,
  factNaturalKey,
  markSent,
  restartAttempt,
  __resetQueueForTests,
} from '../queue';
import { flushPending, flushAll, __resetSyncForTests, type SyncApi } from '../sync';

const QUEST = 'mystery-fortress-v1';
const SNAP = 'snap-v1';
const PLAYER = 'demo-player';

function fact(partial: Partial<Fact> = {}): Fact {
  return {
    type: 'physical_confirmed',
    step_position: 0,
    submitted_value: null,
    local_is_correct: true,
    coins_delta: 0,
    note: null,
    device_id: 'device-a',
    ...partial,
  };
}

/** Stub api that registers attempts and echoes a server projection. */
function stubApi(overrides: Partial<SyncApi> = {}): SyncApi & { calls: Record<string, number> } {
  const calls = { createAttempt: 0, checkout: 0, appendFacts: 0 };
  return {
    calls,
    createAttempt: vi.fn(async () => {
      calls.createAttempt += 1;
      return { attempt_id: `srv-${calls.createAttempt}`, snapshot_id: SNAP };
    }),
    checkout: vi.fn(async () => {
      calls.checkout += 1;
      return {};
    }),
    appendFacts: vi.fn(async (_id: string, facts: Fact[]) => {
      calls.appendFacts += 1;
      return {
        accepted: facts,
        projected: { balance: 7, completed_steps: [0, 1], revealed_hints: [] },
      };
    }),
    ...overrides,
  };
}

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory();
  __resetQueueForTests();
  __resetSyncForTests();
});

describe('flushPending', () => {
  it('happy path: registers attempt, posts pending, marks sent, returns projections', async () => {
    const a = await ensureActiveAttempt(QUEST, SNAP);
    await appendFact(a.attempt_key, fact({ step_position: 0 }));
    await appendFact(a.attempt_key, fact({ type: 'gift_claimed', step_position: 2, coins_delta: 5 }));

    const api = stubApi();
    const result = await flushPending({ questId: QUEST, playerId: PLAYER, api });

    expect(result).not.toBeNull();
    expect(result!.flushed).toBe(2);
    expect(result!.authoritative).toEqual({ balance: 7, completedSteps: [0, 1], revealedHints: [] });
    expect(result!.localBefore.balance).toBe(5); // full local log projection pre-flush
    expect(api.calls.createAttempt).toBe(1);
    expect(api.calls.appendFacts).toBe(1);
    expect((await getActiveAttempt(QUEST))?.server_attempt_id).toBe('srv-1');
    expect(await getPendingFacts(a.attempt_key)).toHaveLength(0);
    expect((await getFacts(a.attempt_key)).every((r) => r.status === 'sent')).toBe(true);
  });

  it('reuses a bound server_attempt_id without re-registering', async () => {
    const a = await ensureActiveAttempt(QUEST, SNAP);
    await appendFact(a.attempt_key, fact());
    const api = stubApi();
    await flushPending({ questId: QUEST, playerId: PLAYER, api });
    await appendFact(a.attempt_key, fact({ step_position: 1 }));
    await flushPending({ questId: QUEST, playerId: PLAYER, api });
    expect(api.calls.createAttempt).toBe(1);
    expect(api.calls.appendFacts).toBe(2);
  });

  it('falls back to checkout-then-create when attempt creation is refused (no grant)', async () => {
    const a = await ensureActiveAttempt(QUEST, SNAP);
    await appendFact(a.attempt_key, fact());
    let first = true;
    const api = stubApi();
    const failingCreate = vi.fn(async () => {
      if (first) {
        first = false;
        throw new Error('API 403 /api/attempts: no grant');
      }
      return { attempt_id: 'srv-after-checkout', snapshot_id: SNAP };
    });
    api.createAttempt = failingCreate;

    const result = await flushPending({ questId: QUEST, playerId: PLAYER, api });
    expect(result?.flushed).toBe(1);
    expect(api.calls.checkout).toBe(1);
    expect((await getActiveAttempt(QUEST))?.server_attempt_id).toBe('srv-after-checkout');
  });

  it('no-ops with no attempt or with nothing pending', async () => {
    const api = stubApi();
    expect(await flushPending({ questId: QUEST, playerId: PLAYER, api })).toBeNull();

    const a = await ensureActiveAttempt(QUEST, SNAP);
    const f = fact();
    await appendFact(a.attempt_key, f);
    await markSent(a.attempt_key, [factNaturalKey(f)]);
    expect(await flushPending({ questId: QUEST, playerId: PLAYER, api })).toBeNull();
    expect(api.calls.appendFacts).toBe(0);
    expect(api.calls.createAttempt).toBe(0);
  });

  it('a failed POST leaves every fact pending and the flush rejects', async () => {
    const a = await ensureActiveAttempt(QUEST, SNAP);
    await appendFact(a.attempt_key, fact());
    const api = stubApi({
      appendFacts: vi.fn(async () => {
        throw new Error('network down');
      }),
    });
    await expect(flushPending({ questId: QUEST, playerId: PLAYER, api })).rejects.toThrow('network down');
    expect(await getPendingFacts(a.attempt_key)).toHaveLength(1);
    // and a later retry succeeds
    const ok = stubApi();
    expect((await flushPending({ questId: QUEST, playerId: PLAYER, api: ok }))?.flushed).toBe(1);
  });

  it('single-flight: concurrent flushes share one registration and one POST', async () => {
    const a = await ensureActiveAttempt(QUEST, SNAP);
    await appendFact(a.attempt_key, fact());

    // Slow registration so the second call arrives while the first is in flight.
    const api = stubApi();
    const slowCreate = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 20));
      api.calls.createAttempt += 1;
      return { attempt_id: 'srv-once', snapshot_id: SNAP };
    });
    api.createAttempt = slowCreate;

    const [r1, r2] = await Promise.all([
      flushPending({ questId: QUEST, playerId: PLAYER, api }),
      flushPending({ questId: QUEST, playerId: PLAYER, api }),
    ]);
    expect(api.calls.createAttempt).toBe(1);
    expect(api.calls.appendFacts).toBe(1);
    expect(r1).toBe(r2); // both callers observe the same flush
  });
});

describe('flushAll', () => {
  it('drains a SUPERSEDED attempt whose finish never synced (the stranded-completion fix)', async () => {
    // Play + complete attempt A but never flush it, then «Начать заново» supersedes
    // it. flushPending (active-only) would now flush the empty attempt B and leave
    // A's completion stranded forever — flushAll is what recovers it.
    const a = await ensureActiveAttempt(QUEST, SNAP);
    await appendFact(a.attempt_key, fact({ type: 'attempt_completed', step_position: 3 }));
    await appendFact(a.attempt_key, fact({ type: 'completion_bonus', step_position: 3, coins_delta: 5 }));
    await restartAttempt(QUEST, SNAP); // A → superseded, B → active (empty)

    // The active-only flush ignores A entirely.
    const activeOnly = stubApi();
    await flushPending({ questId: QUEST, playerId: PLAYER, api: activeOnly });
    expect(activeOnly.calls.appendFacts).toBe(0);
    expect(await getPendingFacts(a.attempt_key)).toHaveLength(2); // still stranded

    // flushAll sweeps every attempt and drains A.
    const api = stubApi();
    await flushAll({ playerId: PLAYER, api });
    expect(api.calls.createAttempt).toBe(1); // registered A
    expect(api.calls.appendFacts).toBe(1);
    expect(await getPendingFacts(a.attempt_key)).toHaveLength(0);
  });

  it('flushes every quest that has pending facts and skips the clean ones', async () => {
    const a1 = await ensureActiveAttempt('q1', SNAP);
    await appendFact(a1.attempt_key, fact());
    const a2 = await ensureActiveAttempt('q2', SNAP);
    await appendFact(a2.attempt_key, fact({ type: 'gift_claimed', step_position: 2, coins_delta: 5 }));
    // q3 exists but has nothing pending → no POST for it.
    await ensureActiveAttempt('q3', SNAP);

    const api = stubApi();
    await flushAll({ playerId: PLAYER, api });
    expect(api.calls.createAttempt).toBe(2);
    expect(api.calls.appendFacts).toBe(2);
    expect(await getPendingFacts(a1.attempt_key)).toHaveLength(0);
    expect(await getPendingFacts(a2.attempt_key)).toHaveLength(0);
  });

  it('is best-effort: one unrecoverable attempt does not block the others', async () => {
    const good = await ensureActiveAttempt('q-good', SNAP);
    await appendFact(good.attempt_key, fact());
    const bad = await ensureActiveAttempt('q-bad', SNAP);
    await appendFact(bad.attempt_key, fact());

    const api = stubApi();
    // q-bad can neither register nor checkout → its flush rejects; q-good still syncs.
    api.createAttempt = vi.fn(async (body: { quest_id: string }) => {
      if (body.quest_id === 'q-bad') throw new Error('API 403 /api/attempts: no grant');
      api.calls.createAttempt += 1;
      return { attempt_id: `srv-${api.calls.createAttempt}`, snapshot_id: SNAP };
    });
    api.checkout = vi.fn(async (body: { quest_id: string }) => {
      if (body.quest_id === 'q-bad') throw new Error('API 402 /api/checkout: payment failed');
      api.calls.checkout += 1;
      return {};
    });

    await expect(flushAll({ playerId: PLAYER, api })).resolves.toBeUndefined();
    expect(await getPendingFacts(good.attempt_key)).toHaveLength(0); // good synced
    expect(await getPendingFacts(bad.attempt_key)).toHaveLength(1); // bad left pending, retry-safe
  });

  it('no-ops cleanly when there is nothing pending anywhere', async () => {
    const a = await ensureActiveAttempt(QUEST, SNAP);
    const f = fact();
    await appendFact(a.attempt_key, f);
    await markSent(a.attempt_key, [factNaturalKey(f)]);

    const api = stubApi();
    await flushAll({ playerId: PLAYER, api });
    expect(api.calls.appendFacts).toBe(0);
    expect(api.calls.createAttempt).toBe(0);
  });
});
