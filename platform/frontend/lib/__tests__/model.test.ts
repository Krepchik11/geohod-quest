/**
 * Shared-model unit tests: matcher contract, publish validation, snapshot
 * serialization, golden projection, grants, and sync-correction derivation.
 */
import { describe, expect, it } from 'vitest';
import * as model from '../shared-model';
import { getPlaythrough, getSnapshot } from '../goldens';

describe('isAnswerCorrect (verbatim design/player/matcher.js contract)', () => {
  const realList = ['ПУПИН', 'МИХАЙЛО ПУПИН'];

  it('matches a real synonym exactly after trim+lowercase', () => {
    expect(model.isAnswerCorrect('МИХАЙЛО ПУПИН', realList)).toBe(true);
    expect(model.isAnswerCorrect('  михайло пупин  ', realList)).toBe(true);
  });

  it('rejects non-members, blanks, and partial matches', () => {
    expect(model.isAnswerCorrect('wrong', realList)).toBe(false);
    expect(model.isAnswerCorrect('', realList)).toBe(false);
    expect(model.isAnswerCorrect('   ', realList)).toBe(false);
    expect(model.isAnswerCorrect('МИХАЙЛО', realList)).toBe(false); // no contains
  });

  it('handles null/empty acceptable lists', () => {
    expect(model.isAnswerCorrect('x', null)).toBe(false);
    expect(model.isAnswerCorrect('x', [])).toBe(false);
  });
});

describe('validateForPublish + serializeToSnapshot', () => {
  it('accepts the golden snapshot (errors empty)', () => {
    const snap = model.loadQuestSnapshot(getSnapshot('mystery-fortress-v1'));
    expect(model.validateForPublish(snap).errors).toEqual([]);
  });

  it('serializes preserving steps and bumping version', () => {
    const snap = getSnapshot('mystery-fortress-v1');
    const serialized = model.serializeToSnapshot(snap);
    expect(serialized.steps.length).toBe(snap.steps.length);
    expect(serialized.snapshot_version).toBe(snap.snapshot_version + 1);
  });

  it('accepts a 7-template demo snapshot', () => {
    const demo7 = {
      golden_id: 'ironia-sudby-v1',
      name: 'Ирония судьбы',
      snapshot_version: 1,
      steps: (['start', 'video', 'task_no', 'task_answer', 'continue', 'route_video', 'congrats'] as const).map(
        (template, position) => ({
          position,
          template,
          rich_content: { title: template, main_text: 'text' },
          media: {},
          completion:
            template === 'task_answer'
              ? { mode: 'answer' as const, acceptable: ['1730'] }
              : { mode: 'physical' as const },
        })
      ),
    };
    expect(model.validateForPublish(demo7).errors).toEqual([]);
    expect(demo7.steps.length).toBe(7);
  });
});

describe('golden projection', () => {
  it('projectBalance matches the playthrough golden', () => {
    const play = getPlaythrough('happy-with-gift');
    expect(model.projectBalance(play.expected_facts)).toBe(play.expected_final_balance);
    expect(model.projectState(play.expected_facts).completedSteps.length).toBeGreaterThan(0);
  });
});

describe('AccessGrant idempotency', () => {
  it('first creates, second returns existing with source preserved', () => {
    const g1 = model.createGrantIdemp(null, 'demo-player', 'mystery-fortress-v1', 'Payment');
    expect(g1.created).toBe(true);
    const g2 = model.createGrantIdemp(g1.grant, 'demo-player', 'mystery-fortress-v1', 'CouponRedemption');
    expect(g2.created).toBe(false);
    expect(g2.grant.source).toBe('Payment');
  });

  it('eligibility: grant or free, otherwise blocked', () => {
    const g = model.createGrantIdemp(null, 'p', 'q', 'FreeQuest').grant;
    expect(model.isEligibleForAttempt(g, 'q')).toBe(true);
    expect(model.isEligibleForAttempt(null, 'free-q', true)).toBe(true);
    expect(model.isEligibleForAttempt(null, 'paid-q')).toBe(false);
  });
});

describe('deriveSyncCorrections (the only source of correction UI events)', () => {
  const state = (balance: number, completed: number[]): model.ProjectedState => ({
    balance,
    completedSteps: completed,
    revealedHints: [],
  });

  it('identical projections produce no corrections', () => {
    expect(model.deriveSyncCorrections(state(5, [0, 1]), state(5, [0, 1]))).toEqual({});
  });

  it('balance drift after merge produces the «Баланс обновлён» notice, including negative values', () => {
    const c = model.deriveSyncCorrections(state(5, [0]), state(-3, [0]));
    expect(c.balanceNotice).toEqual({ old: 5, new: -3 });
    expect(c.advanceOffer).toBeUndefined();
  });

  it('authoritative furthest step ahead produces the advance offer', () => {
    const c = model.deriveSyncCorrections(state(5, [0, 2]), state(5, [0, 2, 4]));
    expect(c.advanceOffer).toEqual({ local_step: 2, server_step: 4 });
  });

  it('local ahead of server offers nothing (steps never lost, union only advances)', () => {
    expect(model.deriveSyncCorrections(state(0, [0, 3]), state(0, [0])).advanceOffer).toBeUndefined();
  });

  it('empty local vs progressed server offers from -1', () => {
    const c = model.deriveSyncCorrections(state(0, []), state(0, [0, 1]));
    expect(c.advanceOffer).toEqual({ local_step: -1, server_step: 1 });
  });
});
