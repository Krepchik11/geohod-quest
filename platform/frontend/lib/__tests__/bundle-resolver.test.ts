// @vitest-environment node
/**
 * The gate resolver decides which snapshot a quest opens on. The invariant under
 * test is the one the version bug violated: a RESTART is a fresh run and must
 * adopt the LATEST published snapshot from the server, even when the device
 * still holds an active attempt + cached bundle frozen to an OLDER version. A
 * RESUME, by contrast, keeps the in-progress attempt's pinned snapshot (version
 * freeze). Network is injected; the queue is the real fake-indexeddb store.
 */
import 'fake-indexeddb/auto';
import { ApiError } from '../api';
import { IDBFactory } from 'fake-indexeddb';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { QuestSnapshot } from '../shared-model';
import {
  ensureActiveAttempt,
  getActiveAttempt,
  getFacts,
  appendFact,
  putBundle,
  __resetQueueForTests,
} from '../queue';
import { resolveGate, type ResolverDeps } from '../bundle-resolver';

const QUEST = 'q1';
const OLD = 'q1-v1';
const NEW = 'q1-v2';

function snap(version: number): QuestSnapshot {
  return { golden_id: QUEST, name: `Quest v${version}`, snapshot_version: version, steps: [] };
}

function wire(snapshotId: string, version: number) {
  return { quest_id: QUEST, snapshot_id: snapshotId, snapshot_version: version, primary_comic: null, snapshot: snap(version) };
}

function deps(over: Partial<ResolverDeps> = {}): ResolverDeps {
  return {
    userId: 'dev:x',
    online: true,
    getBundle: vi.fn(async () => wire(NEW, 2)),
    persist: vi.fn(async () => {}),
    ...over,
  };
}

/** Seed the device as a player who already finished v1: active attempt + cached v1 bundle. */
async function seedPlayedOldVersion() {
  const attempt = await ensureActiveAttempt(QUEST, OLD);
  await appendFact(attempt.attempt_key, {
    type: 'attempt_completed', step_position: 0, submitted_value: null,
    local_is_correct: true, coins_delta: 0, note: null, device_id: 'dev:x',
  });
  await putBundle({ snapshot_id: OLD, quest_id: QUEST, version: 1, snapshot: snap(1), size_bytes: 1, downloaded_at: 'now' });
  return attempt;
}

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory();
  __resetQueueForTests();
});

describe('resolveGate — restart adopts the latest published version', () => {
  it('restart fetches the server bundle and binds a fresh attempt to the NEW snapshot', async () => {
    const old = await seedPlayedOldVersion();
    const d = deps();

    const res = await resolveGate(QUEST, true, d);

    expect(res).toMatchObject({ kind: 'ready', snapshotId: NEW });
    expect(d.getBundle).toHaveBeenCalledWith(QUEST, 'dev:x');
    // the active attempt is now a NEW, empty run bound to the latest snapshot
    const active = await getActiveAttempt(QUEST);
    expect(active?.snapshot_id).toBe(NEW);
    expect(active?.attempt_key).not.toBe(old.attempt_key);
    expect(await getFacts(active!.attempt_key)).toHaveLength(0);
    // old run's facts (and coins) are preserved on the superseded attempt
    expect(await getFacts(old.attempt_key)).toHaveLength(1);
  });

  it('restart offline falls back to the latest bundle already on the device', async () => {
    await seedPlayedOldVersion();
    const d = deps({ online: false, getBundle: vi.fn(async () => { throw new Error('offline'); }) });

    const res = await resolveGate(QUEST, true, d);

    expect(res).toMatchObject({ kind: 'ready', snapshotId: OLD });
    expect((await getActiveAttempt(QUEST))?.snapshot_id).toBe(OLD);
  });
});

describe('resolveGate — resume keeps the pinned snapshot (version freeze)', () => {
  it('resume opens the in-progress attempt on its OWN snapshot, never re-fetching', async () => {
    await seedPlayedOldVersion();
    const d = deps();

    const res = await resolveGate(QUEST, false, d);

    expect(res).toMatchObject({ kind: 'ready', snapshotId: OLD });
    expect(d.getBundle).not.toHaveBeenCalled();
  });
});

describe('resolveGate — error classification', () => {
  const err = (status: number) => new ApiError(status, '/api/quests/q/bundle', 'boom');

  it('403 → denied, 401 → login-required, other → unavailable(offline flag)', async () => {
    expect(await resolveGate(QUEST, false, deps({ getBundle: vi.fn(async () => { throw err(403); }) }))).toEqual({ kind: 'denied' });
    expect(await resolveGate(QUEST, false, deps({ getBundle: vi.fn(async () => { throw err(401); }) }))).toEqual({ kind: 'login-required' });
    expect(await resolveGate(QUEST, false, deps({ online: false, getBundle: vi.fn(async () => { throw new Error('network'); }) }))).toEqual({ kind: 'unavailable', offline: true });
  });
});
