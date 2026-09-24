/**
 * Wrong-answer popup rule (SPEC §Wrong-Answer / Hint Flow): the popup opens after
 * EVERY wrong answer on an unsolved answer step, next to the inline error. It
 * always offers the skip; the hint part follows the hint's state (for sale /
 * bought / absent). A solved step never opens it — `solvedAnswerAt` says what was
 * accepted there. The decision is derived from the fact log alone — no parallel
 * counter state exists to drift.
 */
import { describe, expect, it } from 'vitest';
import type { Fact, GameStep } from '../shared-model';
import { projectState, solvedAnswerAt, wrongAnswersAt, wrongPopupAt, wrongPopupFor } from '../shared-model';

const DEVICE = 'dev-test';

function wrong(pos: number, value: string): Fact {
  return {
    type: 'answer_submitted',
    step_position: pos,
    submitted_value: value,
    local_is_correct: false,
    coins_delta: 0,
    note: null,
    device_id: DEVICE,
  };
}

function correct(pos: number, value: string): Fact {
  return { ...wrong(pos, value), local_is_correct: true };
}

function hintPurchase(pos: number): Fact {
  return {
    type: 'hint_purchased',
    step_position: pos,
    submitted_value: null,
    local_is_correct: true,
    coins_delta: -5,
    note: null,
    device_id: DEVICE,
  };
}

function skipped(pos: number): Fact {
  return {
    type: 'task_skipped',
    step_position: pos,
    submitted_value: '1730',
    local_is_correct: true,
    coins_delta: -10,
    note: null,
    device_id: DEVICE,
  };
}

const hintStep: GameStep = {
  position: 4,
  template: 'task_answer',
  rich_content: { title: 'Год освящения', main_text: 'Взгляните на табличку' },
  media: {},
  completion: { mode: 'answer', acceptable: ['1730'] },
  supporting: { hint: { cost_coins: 5, reveal_text: 'Цифры выбиты в арке' } },
};

const hintlessStep: GameStep = { ...hintStep, supporting: {} };

const physicalStep: GameStep = { ...hintStep, template: 'task_no', completion: { mode: 'physical' } };

describe('wrongAnswersAt', () => {
  it('counts only incorrect answer_submitted facts at the position', () => {
    const facts = [wrong(4, '1700'), correct(4, '1730'), wrong(3, 'x'), hintPurchase(4)];
    expect(wrongAnswersAt(facts, 4)).toBe(1);
    expect(wrongAnswersAt(facts, 3)).toBe(1);
    expect(wrongAnswersAt(facts, 0)).toBe(0);
  });
});

describe('wrongPopupFor — the one table', () => {
  const base = { wrongs: 1, hasHint: true, purchased: false, completed: false };

  it('no popup before the first wrong answer', () => {
    expect(wrongPopupFor({ ...base, wrongs: 0 })).toBeNull();
  });

  it('hint for sale → offer; bought → reveal for free; absent → none', () => {
    expect(wrongPopupFor(base)).toEqual({ hint: 'offer' });
    expect(wrongPopupFor({ ...base, purchased: true })).toEqual({ hint: 'reveal' });
    expect(wrongPopupFor({ ...base, hasHint: false })).toEqual({ hint: 'none' });
  });

  it('a solved step never opens it', () => {
    expect(wrongPopupFor({ ...base, completed: true })).toBeNull();
  });
});

describe('wrongPopupAt (fed from the fact log)', () => {
  it('opens on the FIRST wrong answer, and on every one after it', () => {
    expect(wrongPopupAt([], 4, hintStep)).toBeNull();
    expect(wrongPopupAt([wrong(4, '1700')], 4, hintStep)).toEqual({ hint: 'offer' });
    expect(wrongPopupAt([wrong(4, 'a'), wrong(4, 'b')], 4, hintStep)).not.toBeNull();
    expect(wrongPopupAt([wrong(4, 'a'), wrong(4, 'b'), wrong(4, 'c')], 4, hintStep)).not.toBeNull();
  });

  it('shows the bought hint for free instead of selling it again', () => {
    const facts = [wrong(4, 'a'), hintPurchase(4), wrong(4, 'c')];
    expect(wrongPopupAt(facts, 4, hintStep)).toEqual({ hint: 'reveal' });
  });

  it('still opens on a step without a hint — the skip is always on offer', () => {
    expect(wrongPopupAt([wrong(4, 'a')], 4, hintlessStep)).toEqual({ hint: 'none' });
  });

  it('counts wrongs per step, not globally', () => {
    expect(wrongPopupAt([wrong(1, 'a')], 4, hintStep)).toBeNull();
    expect(wrongPopupAt([hintPurchase(1), wrong(4, 'b')], 4, hintStep)).toEqual({ hint: 'offer' });
  });

  it('never opens on a solved step — answered or skipped — but a solve elsewhere does not count', () => {
    expect(wrongPopupAt([correct(4, '1730'), wrong(4, 'x')], 4, hintStep)).toBeNull();
    expect(wrongPopupAt([wrong(4, 'a'), skipped(4), wrong(4, 'x')], 4, hintStep)).toBeNull();
    expect(wrongPopupAt([skipped(3), wrong(4, 'x')], 4, hintStep)).toEqual({ hint: 'offer' });
  });

  it('never opens on a step that takes no answer', () => {
    expect(wrongPopupAt([wrong(4, 'a')], 4, physicalStep)).toBeNull();
  });
});

describe('solvedAnswerAt', () => {
  it('unsolved while there are only wrong answers and hint purchases', () => {
    expect(solvedAnswerAt([], 4)).toBeNull();
    expect(solvedAnswerAt([wrong(4, 'a'), hintPurchase(4)], 4)).toBeNull();
  });

  it('answered right → the player\'s own answer', () => {
    expect(solvedAnswerAt([wrong(4, 'a'), correct(4, '1730')], 4)).toEqual({ answer: '1730' });
  });

  it('skipped → the substituted answer', () => {
    expect(solvedAnswerAt([wrong(4, 'a'), skipped(4)], 4)).toEqual({ answer: '1730' });
  });

  it('the latest completing fact wins; other steps never count', () => {
    expect(solvedAnswerAt([skipped(4), correct(4, 'тысяча семьсот тридцать')], 4)).toEqual({
      answer: 'тысяча семьсот тридцать',
    });
    expect(solvedAnswerAt([correct(3, '1730')], 4)).toBeNull();
  });

  it('a skip with nothing to substitute is solved with no answer', () => {
    expect(solvedAnswerAt([{ ...skipped(4), submitted_value: null }], 4)).toEqual({ answer: null });
  });
});

describe('task_skipped in the fold', () => {
  it('completes its step and charges the skip', () => {
    const state = projectState([wrong(4, 'a'), hintPurchase(4), skipped(4)]);
    expect(state.completedSteps).toEqual([4]);
    expect(state.balance).toBe(-15);
    expect(state.revealedHints).toEqual([4]);
  });
});
