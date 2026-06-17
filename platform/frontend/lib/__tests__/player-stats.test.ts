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
  gatherOtherAttemptLogs,
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

describe('gatherOtherAttemptLogs (in-play wallet slice)', () => {
  beforeEach(() => {
    globalThis.indexedDB = new IDBFactory();
    __resetQueueForTests();
  });

  it('excludes the active attempt and returns every other attempt', async () => {
    const a = await ensureActiveAttempt('q1', 'snap-v1');
    await appendFact(a.attempt_key, gift(3));
    const b = await restartAttempt('q1', 'snap-v1'); // b is now active, a superseded

    const others = await gatherOtherAttemptLogs(b.attempt_key);
    expect(others).toHaveLength(1); // only the superseded attempt a
    expect(others[0].quest_id).toBe('q1');
    expect(others[0].facts.some((f) => f.type === 'gift_claimed')).toBe(true);
  });

  it('a null active key returns every attempt (no active attempt yet)', async () => {
    const a = await ensureActiveAttempt('q1', 'snap-v1');
    await appendFact(a.attempt_key, gift(3));
    expect(await gatherOtherAttemptLogs(null)).toHaveLength(1);
  });

  it('the replay wallet continues from its real value with the bonus deduped', async () => {
    // The reported bug: finish a quest (gift 3 + bonus 5 = 8), replay, and the top
    // bar reset to 0 while the profile kept climbing. The wallet is now the fold of
    // the prior attempts + this attempt's LIVE facts, so it continues from 8 and the
    // once-per-quest bonus never re-credits.
    const a = await ensureActiveAttempt('q1', 'snap-v1');
    await appendFact(a.attempt_key, gift(3));
    await appendFact(a.attempt_key, bonus());
    await appendFact(a.attempt_key, completed());
    const b = await restartAttempt('q1', 'snap-v1');

    const priorLogs = await gatherOtherAttemptLogs(b.attempt_key);
    const priorWallet = foldLocalPlayerStats(priorLogs).balance;
    expect(priorWallet).toBe(8); // wallet at the START of the replay — not 0

    // Replay re-earns the gift and re-emits a (locally distinct) completion bonus.
    const liveFacts: Fact[] = [gift(3), bonus(), completed()];
    const wallet = foldLocalPlayerStats([...priorLogs, { quest_id: 'q1', facts: liveFacts }]).balance;
    expect(wallet).toBe(11); // 8 + re-earned gift 3; the +5 bonus is deduped once-per-quest
    expect(wallet - priorWallet).toBe(3); // «монет собрано» this run == what the wallet actually gained
  });
});
