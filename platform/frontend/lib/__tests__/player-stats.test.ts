/**
 * TDD for lib/player-stats.ts — the local cross-attempt fold (mirrors the backend
 * facts::project_player_stats) and the server↔local merge the profile renders.
 */
import 'fake-indexeddb/auto';
import { describe, expect, it, beforeEach } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import type { Fact } from '../shared-model';
import {
  foldLocalPlayerStats,
  gatherLocalAttemptLogs,
  mergeProfileStats,
  type AttemptLog,
  type PlayerStatsFold,
} from '../player-stats';
import {
  ensureActiveAttempt,
  appendFact,
  restartAttempt,
  __resetQueueForTests,
} from '../queue';

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

const gift = (coins = 5) => fact({ type: 'gift_claimed', step_position: 2, coins_delta: coins });
const bonus = () => fact({ type: 'completion_bonus', step_position: 3, coins_delta: 5 });
const completed = () => fact({ type: 'attempt_completed', step_position: 3 });
const hint = (cost = 5) => fact({ type: 'hint_purchased', step_position: 1, coins_delta: -cost });

describe('foldLocalPlayerStats', () => {
  it('sums signed coins and marks a quest completed on attempt_completed', () => {
    const logs: AttemptLog[] = [{ quest_id: 'q1', facts: [gift(5), hint(2), completed()] }];
    expect(foldLocalPlayerStats(logs)).toEqual({ balance: 3, completed_quest_ids: ['q1'] });
  });

  it('counts the completion bonus once per quest across replays (server parity)', () => {
    // Two attempts of the SAME quest each carry their own bonus locally; the server
    // dedups it once-per-(player,quest), so the fold must collapse it to a single +5.
    const logs: AttemptLog[] = [
      { quest_id: 'q1', facts: [gift(5), bonus(), completed()] },
      { quest_id: 'q1', facts: [gift(5), bonus(), completed()] },
    ];
    // gift+5 (a1) + bonus+5 (once) + gift+5 (a2) = 15; bonus on a2 dropped.
    expect(foldLocalPlayerStats(logs)).toEqual({ balance: 15, completed_quest_ids: ['q1'] });
  });

  it('keeps a separate completion bonus per DISTINCT quest', () => {
    const logs: AttemptLog[] = [
      { quest_id: 'q1', facts: [bonus(), completed()] },
      { quest_id: 'q2', facts: [bonus(), completed()] },
    ];
    expect(foldLocalPlayerStats(logs)).toEqual({ balance: 10, completed_quest_ids: ['q1', 'q2'] });
  });

  it('an in-progress quest (no attempt_completed) is not counted, but its coins are', () => {
    const logs: AttemptLog[] = [{ quest_id: 'q1', facts: [gift(5)] }];
    expect(foldLocalPlayerStats(logs)).toEqual({ balance: 5, completed_quest_ids: [] });
  });

  it('overdraft stays negative and the completed list is sorted', () => {
    const logs: AttemptLog[] = [
      { quest_id: 'zeta', facts: [hint(9), completed()] },
      { quest_id: 'alpha', facts: [completed()] },
    ];
    expect(foldLocalPlayerStats(logs)).toEqual({ balance: -9, completed_quest_ids: ['alpha', 'zeta'] });
  });

  it('empty input folds to zeros', () => {
    expect(foldLocalPlayerStats([])).toEqual({ balance: 0, completed_quest_ids: [] });
  });
});

describe('mergeProfileStats', () => {
  const local: PlayerStatsFold = { balance: 15, completed_quest_ids: ['q1', 'q2'] };

  it('uses the local fold alone when the server is unreachable', () => {
    expect(mergeProfileStats(null, local)).toEqual({ balance: 15, completedIds: ['q1', 'q2'] });
  });

  it('unions completed quests and takes the higher balance', () => {
    const server: PlayerStatsFold = { balance: 20, completed_quest_ids: ['q1'] };
    expect(mergeProfileStats(server, local)).toEqual({
      balance: 20, // server ahead (another device)
      completedIds: ['q1', 'q2'], // q2 known only locally still shows
    });
  });

  it('prefers local balance when local is ahead of a lagging server', () => {
    const server: PlayerStatsFold = { balance: 5, completed_quest_ids: ['q1'] };
    const localAhead: PlayerStatsFold = { balance: 15, completed_quest_ids: ['q1'] };
    expect(mergeProfileStats(server, localAhead)).toEqual({ balance: 15, completedIds: ['q1'] });
  });
});

describe('gatherLocalAttemptLogs (queue integration)', () => {
  beforeEach(() => {
    globalThis.indexedDB = new IDBFactory();
    __resetQueueForTests();
  });

  it('gathers one log per attempt — active AND superseded — so a stranded finish counts', async () => {
    const a = await ensureActiveAttempt('q1', 'snap-v1');
    await appendFact(a.attempt_key, gift(5));
    await appendFact(a.attempt_key, completed());
    // «Начать заново»: A is superseded, B is the fresh active attempt.
    const b = await restartAttempt('q1', 'snap-v1');
    await appendFact(b.attempt_key, gift(5));

    const logs = await gatherLocalAttemptLogs();
    expect(logs).toHaveLength(2); // both attempts gathered

    const stats = foldLocalPlayerStats(logs);
    // a: gift+5 + completed; b: gift+5 → 10, completed via the superseded attempt.
    expect(stats).toEqual({ balance: 10, completed_quest_ids: ['q1'] });
  });
});
