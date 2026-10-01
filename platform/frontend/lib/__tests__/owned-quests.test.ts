/**
 * lib/owned-quests — one owned quest as this device knows it (state, step,
 * download), the store's own-first order, and the hero's «Продолжить».
 */
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { appendFact, ensureActiveAttempt, putBundle, __resetQueueForTests, type BundleRow } from '../queue';
import { removeDownloadedQuest } from '../download';
import { getSnapshot } from '../goldens';
import { loadQuestSnapshot, type Fact } from '../shared-model';
import { FRESH_STATUS, latestInProgress, orderOwned, ownedStatus, type OwnedStatus } from '../owned-quests';

const QUEST = 'mystery-fortress-v1';
const SNAPSHOT = loadQuestSnapshot(getSnapshot(QUEST));

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
  } as Fact;
}

function bundle(questId: string, snapshotId: string, version = 1, name = SNAPSHOT.name): BundleRow {
  return {
    snapshot_id: snapshotId,
    quest_id: questId,
    version,
    snapshot: { ...SNAPSHOT, name },
    size_bytes: 1,
    downloaded_at: '2026-10-01T10:00:00.000Z',
    media_complete: true,
  };
}

/** Pin the clock so queued_at stamps (and with them the ordering) are exact. */
const at = (iso: string) => vi.setSystemTime(new Date(iso));

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory();
  __resetQueueForTests();
  vi.useFakeTimers({ toFake: ['Date'] });
  (globalThis as { caches?: unknown }).caches = undefined;
});
afterEach(() => vi.useRealTimers());

describe('ownedStatus', () => {
  it('a quest with no local trace is new, not downloaded', async () => {
    expect(await ownedStatus(QUEST, 'snap-v1')).toEqual(FRESH_STATUS);
  });

  it('opened but unplayed is still new', async () => {
    await putBundle(bundle(QUEST, 'snap-v1'));
    await ensureActiveAttempt(QUEST, 'snap-v1');
    const s = await ownedStatus(QUEST, 'snap-v1');
    expect(s.state).toBe('new');
    expect(s.bundle?.snapshot_id).toBe('snap-v1');
  });

  it('in progress: the step reached, the step count, the last activity', async () => {
    await putBundle(bundle(QUEST, 'snap-v1'));
    const a = await ensureActiveAttempt(QUEST, 'snap-v1');
    at('2026-10-01T12:00:00.000Z');
    await appendFact(a.attempt_key, fact({ step_position: 0 }));
    at('2026-10-01T12:05:00.000Z');
    await appendFact(a.attempt_key, fact({ step_position: 1 }));
    const s = await ownedStatus(QUEST, 'snap-v1');
    expect(s.state).toBe('progress');
    expect(s.pos).toBe(3);
    expect(s.total).toBe(SNAPSHOT.steps.length);
    expect(s.lastActivity).toBe('2026-10-01T12:05:00.000Z');
  });

  it('done: dated by the completion', async () => {
    const a = await ensureActiveAttempt(QUEST, 'snap-v1');
    await appendFact(a.attempt_key, fact({ step_position: 0 }));
    at('2026-09-28T18:30:00.000Z');
    await appendFact(a.attempt_key, fact({ type: 'attempt_completed', step_position: 1 }));
    const s = await ownedStatus(QUEST, 'snap-v1');
    expect(s.state).toBe('done');
    expect(s.lastActivity).toBe('2026-09-28T18:30:00.000Z');
  });

  it('a finished quest removed from the device keeps «Пройден»', async () => {
    await putBundle(bundle(QUEST, 'snap-v1'));
    const a = await ensureActiveAttempt(QUEST, 'snap-v1');
    await appendFact(a.attempt_key, fact({ type: 'attempt_completed', step_position: 1 }));
    await removeDownloadedQuest(QUEST);
    const s = await ownedStatus(QUEST, 'snap-v1');
    expect(s.state).toBe('done');
    expect(s.bundle).toBeNull();
  });

  it('claims an update only against a known published version', async () => {
    await putBundle(bundle(QUEST, 'snap-v1'));
    expect((await ownedStatus(QUEST, 'snap-v2')).updateAvailable).toBe(true);
    expect((await ownedStatus(QUEST, 'snap-v1')).updateAvailable).toBe(false);
    expect((await ownedStatus(QUEST, null)).updateAvailable).toBe(false); // offline: unknown
  });
});

describe('orderOwned', () => {
  const s = (state: OwnedStatus['state'], lastActivity?: string): OwnedStatus => ({ ...FRESH_STATUS, state, lastActivity });

  it('в процессе → не начатые → пройденные, the most recent first in each', () => {
    const quests = ['done-old', 'new-old', 'prog-old', 'done-new', 'new-new', 'prog-new', 'new-just-bought'].map(
      (quest_id) => ({ quest_id }),
    );
    const statuses = {
      'done-old': s('done', '2026-09-01T00:00:00Z'),
      'done-new': s('done', '2026-09-20T00:00:00Z'),
      'prog-old': s('progress', '2026-09-02T00:00:00Z'),
      'prog-new': s('progress', '2026-09-30T00:00:00Z'),
      'new-old': s('new'),
      'new-new': s('new'),
    };
    const grantedAt = new Map([
      ['new-old', '2026-08-01T00:00:00Z'],
      ['new-new', '2026-09-15T00:00:00Z'],
    ]);
    expect(orderOwned(quests, statuses, grantedAt).map((q) => q.quest_id)).toEqual([
      'prog-new',
      'prog-old',
      'new-just-bought', // a grant not answered yet is the newest of all
      'new-new',
      'new-old',
      'done-new',
      'done-old',
    ]);
  });
});

describe('latestInProgress (the hero\'s «Продолжить»)', () => {
  it('none when nothing is running', async () => {
    const done = await ensureActiveAttempt('q-done', 'snap-d');
    await appendFact(done.attempt_key, fact({ type: 'attempt_completed', step_position: 1 }));
    await ensureActiveAttempt('q-opened', 'snap-o'); // opened, never played
    expect(await latestInProgress()).toBeNull();
  });

  it('the most recently played running quest, named from its download', async () => {
    await putBundle(bundle('q-old', 'snap-old', 1, 'Старый'));
    await putBundle(bundle('q-new', 'snap-new', 1, 'Тайна крепости'));
    const old = await ensureActiveAttempt('q-old', 'snap-old');
    const recent = await ensureActiveAttempt('q-new', 'snap-new');
    at('2026-10-01T09:00:00.000Z');
    await appendFact(recent.attempt_key, fact({ step_position: 0 }));
    at('2026-10-01T11:00:00.000Z');
    await appendFact(old.attempt_key, fact({ step_position: 0 }));
    at('2026-10-01T12:00:00.000Z');
    await appendFact(recent.attempt_key, fact({ step_position: 1 }));
    expect(await latestInProgress()).toEqual({ questId: 'q-new', name: 'Тайна крепости', downloaded: true });
  });

  it('a running quest with nothing on the device has no name and is not downloaded', async () => {
    const a = await ensureActiveAttempt('q-x', 'snap-x');
    await appendFact(a.attempt_key, fact({ step_position: 0 }));
    expect(await latestInProgress()).toEqual({ questId: 'q-x', name: null, downloaded: false });
  });
});
