/**
 * Replay simulation: drive the playthrough golden's actions through the shared
 * pure functions exactly as the player does (matcher, gift claim ON COMPLETION
 * — design/player/prototype.jsx semantics — terminal completion) and assert
 * the emitted facts and projections match the golden.
 */
import { describe, expect, it } from 'vitest';
import * as model from '../shared-model';
import { getPlaythrough, getSnapshot } from '../goldens';

const DEVICE = 'device-a';

/** Replays golden actions into a fact log the way the player emits them. */
function replay(snap: model.QuestSnapshot, play: model.PlaythroughGolden): model.Fact[] {
  const facts: model.Fact[] = [];

  // Gifts are claimed when their step is COMPLETED (confirm / correct answer /
  // terminal entry), never on reach — mirrors QuestPlayerClient.claimGiftIfNeeded.
  const claimGiftIfNeeded = (pos: number) => {
    const step = snap.steps.find((s) => s.position === pos);
    const gift = step?.supporting?.gift;
    if (!gift) return;
    if (facts.some((f) => f.type === 'gift_claimed' && f.step_position === pos)) return;
    facts.push({
      type: 'gift_claimed',
      step_position: pos,
      submitted_value: null,
      local_is_correct: true,
      coins_delta: gift.coins,
      note: gift.narrative_text || null,
      device_id: DEVICE,
    });
  };

  for (const action of play.actions) {
    const step = snap.steps.find((s) => s.position === action.step_position);
    if (!step) continue;

    if (action.type === 'physical_confirm') {
      const isTerminal = !!step.supporting?.terminal;
      facts.push({
        type: isTerminal ? 'attempt_completed' : 'physical_confirmed',
        step_position: action.step_position,
        submitted_value: null,
        local_is_correct: action.local_is_correct,
        coins_delta: 0,
        note: action.note || (isTerminal ? 'Completed the quest' : null),
        device_id: action.device_id || DEVICE,
      });
      claimGiftIfNeeded(action.step_position);
    } else if (action.type === 'submit_answer') {
      const correct = model.isAnswerCorrect(action.value || '', step.completion.acceptable);
      facts.push({
        type: 'answer_submitted',
        step_position: action.step_position,
        submitted_value: action.value || null,
        local_is_correct: correct,
        coins_delta: 0,
        note: null,
        device_id: action.device_id || DEVICE,
      });
      if (correct) claimGiftIfNeeded(action.step_position);
    }
  }
  return facts;
}

describe('happy-with-gift replay', () => {
  const snap = getSnapshot('mystery-fortress-v1');
  const play = getPlaythrough('happy-with-gift');
  const facts = replay(snap, play);

  it('emits exactly the golden expected_facts (matcher verdicts included)', () => {
    expect(facts).toEqual(play.expected_facts);
  });

  it('projects the golden balance and state', () => {
    expect(model.projectBalance(facts)).toBe(play.expected_final_balance);
    const state = model.projectState(facts);
    expect(state.completedSteps.length).toBeGreaterThan(0);
    expect(state.revealedHints).toEqual([]);
  });

  it('survives a localStorage roundtrip with identical projection', () => {
    const restored = JSON.parse(JSON.stringify({ facts, stepIdx: 3 }));
    expect(model.projectBalance(restored.facts)).toBe(play.expected_final_balance);
  });
});

describe('edge facts on top of the happy log', () => {
  const snap = getSnapshot('mystery-fortress-v1');
  const play = getPlaythrough('happy-with-gift');
  const base = replay(snap, play);

  const edge = (f: Partial<model.Fact> & Pick<model.Fact, 'type' | 'step_position'>): model.Fact => ({
    submitted_value: null,
    local_is_correct: true,
    coins_delta: 0,
    note: null,
    device_id: DEVICE,
    ...f,
  });

  const extended = [
    ...base,
    edge({ type: 'answer_submitted', step_position: 1, submitted_value: 'wrong', local_is_correct: false }),
    edge({ type: 'hint_purchased', step_position: 1, coins_delta: -5, note: 'hint' }),
    edge({ type: 'feedback_reported', step_position: 1, note: 'test feedback' }),
    edge({ type: 'navigator_used', step_position: 0 }),
  ];

  it('hint spend reveals the hint and reduces balance (negative allowed)', () => {
    const state = model.projectState(extended);
    expect(state.revealedHints).toEqual([1]);
    expect(state.balance).toBe(play.expected_final_balance - 5);
  });

  it('a wrong answer does not add a completed step', () => {
    const baseState = model.projectState(base);
    const extState = model.projectState(extended);
    expect(extState.completedSteps).toEqual(baseState.completedSteps);
  });

  it('spending into overdraft stays negative — no compensation anywhere', () => {
    const overdraft = [
      ...extended,
      edge({ type: 'hint_purchased', step_position: 3, coins_delta: -50, note: 'deep overdraft' }),
    ];
    expect(model.projectBalance(overdraft)).toBe(play.expected_final_balance - 5 - 50);
  });

  it('multi-device sync derives the balance notice from projection diff', () => {
    const local = model.projectState(base);
    const authoritative = model.projectState(extended);
    const corrections = model.deriveSyncCorrections(local, authoritative);
    expect(corrections.balanceNotice).toEqual({ old: local.balance, new: authoritative.balance });
    expect(corrections.advanceOffer).toBeUndefined();
  });
});

/**
 * P4: the replay driven through the real IndexedDB queue (write-through →
 * hydrate → flush → restart), proving queue persistence preserves golden
 * fidelity and «Начать заново» keeps earned coins.
 */
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { beforeEach } from 'vitest';
import {
  appendFact,
  ensureActiveAttempt,
  getActiveAttempt,
  getFacts,
  getPendingFacts,
  restartAttempt,
  __resetQueueForTests,
} from '../queue';
import { flushPending, __resetSyncForTests, type SyncApi } from '../sync';

describe('queue-backed replay (P4)', () => {
  const snap = getSnapshot('mystery-fortress-v1');
  const play = getPlaythrough('happy-with-gift');
  const QUEST = 'mystery-fortress-v1';

  beforeEach(() => {
    globalThis.indexedDB = new IDBFactory();
    __resetQueueForTests();
    __resetSyncForTests();
  });

  async function writeReplayThroughQueue() {
    const attempt = await ensureActiveAttempt(QUEST, 'snap-v1');
    const facts = replay(snap, play);
    for (const f of facts) await appendFact(attempt.attempt_key, f);
    return { attempt, facts };
  }

  it('hydration from the queue reproduces the golden projection exactly', async () => {
    const { attempt } = await writeReplayThroughQueue();
    const hydrated = (await getFacts(attempt.attempt_key)).map((r) => r.fact);
    expect(hydrated).toEqual(play.expected_facts);
    expect(model.projectBalance(hydrated)).toBe(play.expected_final_balance);
  });

  it('flush marks the golden log sent and a re-flush is a no-op (idempotent reconnect)', async () => {
    const { attempt } = await writeReplayThroughQueue();
    let posts = 0;
    const api: SyncApi = {
      createAttempt: async () => ({ attempt_id: 'srv-1', snapshot_id: 'snap-v1' }),
      checkout: async () => ({}),
      appendFacts: async (_id, facts) => {
        posts += 1;
        const projected = model.projectState(facts as model.Fact[]);
        return {
          accepted: facts,
          projected: {
            balance: projected.balance,
            completed_steps: projected.completedSteps,
            revealed_hints: projected.revealedHints,
          },
        };
      },
    };
    const first = await flushPending({ questId: QUEST, playerId: 'demo-player', api });
    expect(first?.flushed).toBe(play.expected_facts.length);
    // server echoes the same projection → no corrections to derive
    const corr = model.deriveSyncCorrections(first!.localBefore, first!.authoritative);
    expect(corr.balanceNotice).toBeUndefined();
    expect(corr.advanceOffer).toBeUndefined();
    expect(await getPendingFacts(attempt.attempt_key)).toHaveLength(0);
    expect(await flushPending({ questId: QUEST, playerId: 'demo-player', api })).toBeNull();
    expect(posts).toBe(1);
  });

  it('reset keeps coins: restart starts an empty attempt while old facts (and their coins) remain', async () => {
    const { attempt } = await writeReplayThroughQueue();
    const fresh = await restartAttempt(QUEST, 'snap-v1');
    expect((await getActiveAttempt(QUEST))?.attempt_key).toBe(fresh.attempt_key);
    expect(await getFacts(fresh.attempt_key)).toHaveLength(0);
    const oldFacts = (await getFacts(attempt.attempt_key)).map((r) => r.fact);
    expect(model.projectBalance(oldFacts)).toBe(play.expected_final_balance);
  });
});
