/**
 * TDD for lib/queue.ts — the IndexedDB fact queue (attempts / facts / bundles).
 * Runs on fake-indexeddb; each test gets a fresh IDBFactory for full isolation.
 */
import 'fake-indexeddb/auto'; // installs IDBRequest/IDBKeyRange/… globals that idb relies on
import { describe, expect, it, beforeEach } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import type { Fact, QuestSnapshot } from '../shared-model';
import {
  factNaturalKey,
  ensureActiveAttempt,
  getActiveAttempt,
  setServerAttemptId,
  setLastStepIdx,
  restartAttempt,
  openAttempt,
  appendFact,
  getFacts,
  getPendingFacts,
  markSent,
  putBundle,
  getBundle,
  getLatestBundleForQuest,
  migrateLegacyLocalStorage,
  __resetQueueForTests,
} from '../queue';

const QUEST = 'mystery-fortress-v1';
const SNAP = 'snap-v1';

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

/** Minimal in-memory Storage stand-in for migration tests. */
function memoryStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (k: string) => map.get(k) ?? null,
    removeItem: (k: string) => void map.delete(k),
    has: (k: string) => map.has(k),
  };
}

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory();
  __resetQueueForTests();
});

describe('attempts store', () => {
  it('ensureActiveAttempt creates once and is stable across calls', async () => {
    const a = await ensureActiveAttempt(QUEST, SNAP);
    const b = await ensureActiveAttempt(QUEST, SNAP);
    expect(a.attempt_key).toBe(b.attempt_key);
    expect(a.quest_id).toBe(QUEST);
    expect(a.snapshot_id).toBe(SNAP);
    expect(a.status).toBe('active');
    expect(a.last_step_idx).toBe(0);
    expect(await getActiveAttempt(QUEST)).toMatchObject({ attempt_key: a.attempt_key });
  });

  it('getActiveAttempt returns null for unknown quest', async () => {
    expect(await getActiveAttempt('nope')).toBeNull();
  });

  it('setServerAttemptId binds server identity permanently', async () => {
    const a = await ensureActiveAttempt(QUEST, SNAP);
    await setServerAttemptId(a.attempt_key, 'srv-1');
    expect((await getActiveAttempt(QUEST))?.server_attempt_id).toBe('srv-1');
  });

  it('setLastStepIdx persists resume position', async () => {
    const a = await ensureActiveAttempt(QUEST, SNAP);
    await setLastStepIdx(a.attempt_key, 3);
    expect((await getActiveAttempt(QUEST))?.last_step_idx).toBe(3);
  });

  it('restartAttempt supersedes the active attempt but keeps its facts', async () => {
    const a = await ensureActiveAttempt(QUEST, SNAP);
    await appendFact(a.attempt_key, fact({ type: 'gift_claimed', coins_delta: 5 }));
    const b = await restartAttempt(QUEST, 'snap-v2');
    expect(b.attempt_key).not.toBe(a.attempt_key);
    expect(b.snapshot_id).toBe('snap-v2');
    expect((await getActiveAttempt(QUEST))?.attempt_key).toBe(b.attempt_key);
    // old facts untouched (coins remain), new attempt starts empty
    expect(await getFacts(a.attempt_key)).toHaveLength(1);
    expect(await getFacts(b.attempt_key)).toHaveLength(0);
  });
});

describe('openAttempt (player open / «Пройти заново»)', () => {
  /** Drive an attempt all the way to its terminal completion fact. */
  async function completeAnAttempt() {
    const a = await ensureActiveAttempt(QUEST, SNAP);
    await appendFact(a.attempt_key, fact({ type: 'gift_claimed', step_position: 0, coins_delta: 5 }));
    await appendFact(a.attempt_key, fact({ type: 'attempt_completed', step_position: 3 }));
    await setLastStepIdx(a.attempt_key, 3);
    return a;
  }

  it('opens a fresh attempt at step 0 with no start gate on first play', async () => {
    const opened = await openAttempt(QUEST, SNAP);
    expect(opened.facts).toHaveLength(0);
    expect(opened.attempt.last_step_idx).toBe(0);
    expect(opened.showStartGate).toBe(false);
    expect((await getActiveAttempt(QUEST))?.attempt_key).toBe(opened.attempt.attempt_key);
  });

  it('reopens an in-progress attempt with the start gate (continue/restart choice)', async () => {
    const a = await ensureActiveAttempt(QUEST, SNAP);
    await appendFact(a.attempt_key, fact({ step_position: 0 }));
    await setLastStepIdx(a.attempt_key, 1);
    const opened = await openAttempt(QUEST, SNAP);
    expect(opened.attempt.attempt_key).toBe(a.attempt_key);
    expect(opened.facts).toHaveLength(1);
    expect(opened.attempt.last_step_idx).toBe(1);
    expect(opened.showStartGate).toBe(true);
  });

  it('reopening a COMPLETED attempt without restart lands on its terminal step (no gate)', async () => {
    // This is the «stuck on the finale» state the «Пройти заново» button must avoid.
    const a = await completeAnAttempt();
    const opened = await openAttempt(QUEST, SNAP, { restart: false });
    expect(opened.attempt.attempt_key).toBe(a.attempt_key);
    expect(opened.attempt.last_step_idx).toBe(3);
    expect(opened.showStartGate).toBe(false);
    expect(opened.facts.some((f) => f.type === 'attempt_completed')).toBe(true);
  });

  it('restart supersedes the completed attempt and reopens fresh at step 0', async () => {
    const completed = await completeAnAttempt();
    const opened = await openAttempt(QUEST, SNAP, { restart: true });
    // a brand-new, empty attempt — the player starts from the very beginning
    expect(opened.attempt.attempt_key).not.toBe(completed.attempt_key);
    expect(opened.facts).toHaveLength(0);
    expect(opened.attempt.last_step_idx).toBe(0);
    expect(opened.showStartGate).toBe(false);
    expect((await getActiveAttempt(QUEST))?.attempt_key).toBe(opened.attempt.attempt_key);
    // coins are never lost: the superseded attempt keeps its facts
    expect(await getFacts(completed.attempt_key)).toHaveLength(2);
  });
});

describe('facts store', () => {
  it('appendFact writes pending rows and getFacts returns them in append order', async () => {
    const a = await ensureActiveAttempt(QUEST, SNAP);
    await appendFact(a.attempt_key, fact({ step_position: 0 }));
    await appendFact(a.attempt_key, fact({ type: 'answer_submitted', step_position: 1, submitted_value: 'X' }));
    await appendFact(a.attempt_key, fact({ type: 'gift_claimed', step_position: 2, coins_delta: 5 }));
    const rows = await getFacts(a.attempt_key);
    expect(rows.map((r) => r.fact.step_position)).toEqual([0, 1, 2]);
    expect(rows.every((r) => r.status === 'pending')).toBe(true);
    // seq strictly increasing regardless of natural-key lexicographic order
    expect(rows.map((r) => r.seq)).toEqual([...rows.map((r) => r.seq)].sort((x, y) => x - y));
  });

  it('duplicate natural keys collapse to one row (server-mirror idempotency)', async () => {
    const a = await ensureActiveAttempt(QUEST, SNAP);
    const f = fact({ type: 'answer_submitted', step_position: 1, submitted_value: 'WRONG', local_is_correct: false });
    await appendFact(a.attempt_key, f);
    await appendFact(a.attempt_key, { ...f }); // same natural key
    expect(await getFacts(a.attempt_key)).toHaveLength(1);
  });

  it('markSent flips exactly the batch keys; re-append never demotes sent', async () => {
    const a = await ensureActiveAttempt(QUEST, SNAP);
    const f1 = fact({ step_position: 0 });
    const f2 = fact({ type: 'gift_claimed', step_position: 2, coins_delta: 5 });
    await appendFact(a.attempt_key, f1);
    await appendFact(a.attempt_key, f2);
    await markSent(a.attempt_key, [factNaturalKey(f1)]);
    let rows = await getFacts(a.attempt_key);
    expect(rows.find((r) => r.key === factNaturalKey(f1))?.status).toBe('sent');
    expect(rows.find((r) => r.key === factNaturalKey(f2))?.status).toBe('pending');
    // re-append of an already-sent fact must not demote it
    await appendFact(a.attempt_key, { ...f1 });
    rows = await getFacts(a.attempt_key);
    expect(rows.find((r) => r.key === factNaturalKey(f1))?.status).toBe('sent');
    expect(rows).toHaveLength(2);
  });

  it('getPendingFacts returns only pending, in order', async () => {
    const a = await ensureActiveAttempt(QUEST, SNAP);
    const f1 = fact({ step_position: 0 });
    const f2 = fact({ step_position: 3, type: 'attempt_completed' });
    await appendFact(a.attempt_key, f1);
    await appendFact(a.attempt_key, f2);
    await markSent(a.attempt_key, [factNaturalKey(f1)]);
    const pending = await getPendingFacts(a.attempt_key);
    expect(pending).toHaveLength(1);
    expect(pending[0].key).toBe(factNaturalKey(f2));
  });

  it('facts are isolated per attempt_key', async () => {
    const a = await ensureActiveAttempt(QUEST, SNAP);
    await appendFact(a.attempt_key, fact());
    const b = await restartAttempt(QUEST, SNAP);
    await appendFact(b.attempt_key, fact({ step_position: 1 }));
    expect(await getFacts(a.attempt_key)).toHaveLength(1);
    expect(await getFacts(b.attempt_key)).toHaveLength(1);
  });
});

describe('factNaturalKey', () => {
  it('is device-agnostic and mirrors the backend tuple', () => {
    const f1 = fact({ device_id: 'device-a' });
    const f2 = fact({ device_id: 'device-b' });
    expect(factNaturalKey(f1)).toBe(factNaturalKey(f2));
    expect(factNaturalKey(f1)).toBe(JSON.stringify(['physical_confirmed', 0, null, 0, null]));
  });
});

describe('bundles store', () => {
  const snapshot = { golden_id: QUEST, name: 'Тайна крепости', snapshot_version: 1, steps: [] } as unknown as QuestSnapshot;

  it('putBundle/getBundle roundtrip keyed by snapshot_id', async () => {
    await putBundle({ snapshot_id: SNAP, quest_id: QUEST, version: 1, snapshot, size_bytes: 123, downloaded_at: '2026-06-12T00:00:00Z' });
    const row = await getBundle(SNAP);
    expect(row?.snapshot.name).toBe('Тайна крепости');
    expect(await getBundle('missing')).toBeNull();
  });

  it('getLatestBundleForQuest picks the highest version', async () => {
    await putBundle({ snapshot_id: 'snap-v1', quest_id: QUEST, version: 1, snapshot, size_bytes: 1, downloaded_at: '2026-06-10T00:00:00Z' });
    await putBundle({ snapshot_id: 'snap-v2', quest_id: QUEST, version: 2, snapshot: { ...snapshot, snapshot_version: 2 }, size_bytes: 1, downloaded_at: '2026-06-12T00:00:00Z' });
    expect((await getLatestBundleForQuest(QUEST))?.snapshot_id).toBe('snap-v2');
    expect(await getLatestBundleForQuest('other')).toBeNull();
  });
});

describe('localStorage migration', () => {
  const LEGACY_KEY = `quest-player-${QUEST}`;
  const legacyFacts: Fact[] = [
    fact({ step_position: 0, note: 'на месте' }),
    fact({ type: 'answer_submitted', step_position: 1, submitted_value: 'МИХАЙЛО ПУПИН' }),
  ];

  it('imports facts as pending, preserves position, deletes the key', async () => {
    const storage = memoryStorage({
      [LEGACY_KEY]: JSON.stringify({ facts: legacyFacts, stepIdx: 2, attemptId: 'demo-mystery-fortress-v1', ts: 1 }),
    });
    const migrated = await migrateLegacyLocalStorage(QUEST, SNAP, storage);
    expect(migrated).toBe(true);
    const a = await getActiveAttempt(QUEST);
    expect(a).not.toBeNull();
    expect(a!.last_step_idx).toBe(2);
    expect(a!.server_attempt_id).toBeUndefined(); // demo- placeholder is NOT a server id
    const rows = await getFacts(a!.attempt_key);
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.status === 'pending')).toBe(true);
    expect(storage.has(LEGACY_KEY)).toBe(false);
  });

  it('preserves a real legacy server attempt id', async () => {
    const storage = memoryStorage({
      [LEGACY_KEY]: JSON.stringify({ facts: legacyFacts, stepIdx: 1, attemptId: 'a-17', ts: 1 }),
    });
    await migrateLegacyLocalStorage(QUEST, SNAP, storage);
    expect((await getActiveAttempt(QUEST))?.server_attempt_id).toBe('a-17');
  });

  it('is a no-op without a legacy key and idempotent on re-run', async () => {
    const empty = memoryStorage();
    expect(await migrateLegacyLocalStorage(QUEST, SNAP, empty)).toBe(false);
    const storage = memoryStorage({
      [LEGACY_KEY]: JSON.stringify({ facts: legacyFacts, stepIdx: 2, ts: 1 }),
    });
    expect(await migrateLegacyLocalStorage(QUEST, SNAP, storage)).toBe(true);
    expect(await migrateLegacyLocalStorage(QUEST, SNAP, storage)).toBe(false);
    const a = await getActiveAttempt(QUEST);
    expect(await getFacts(a!.attempt_key)).toHaveLength(2); // no duplicates
  });

  it('tolerates corrupt legacy JSON by discarding it', async () => {
    const storage = memoryStorage({ [LEGACY_KEY]: '{not json' });
    expect(await migrateLegacyLocalStorage(QUEST, SNAP, storage)).toBe(false);
    expect(storage.has(LEGACY_KEY)).toBe(false);
    expect(await getActiveAttempt(QUEST)).toBeNull();
  });
});
