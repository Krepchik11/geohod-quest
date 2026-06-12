/**
 * Wrong-answer / hint flow helpers (SPEC §Wrong-Answer / Hint Flow):
 * inline error on the 1st wrong, popup only from the 2nd wrong, never after
 * the hint is purchased, never without a hint. The decision is derived from
 * the fact log alone — no parallel counter state exists to drift.
 */
import { describe, expect, it } from 'vitest';
import type { Fact, GameStep } from '../shared-model';
import { wrongAnswersAt, shouldOfferHint } from '../shared-model';

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

const hintStep: GameStep = {
  position: 4,
  template: 'task_answer',
  rich_content: { title: 'Год освящения', main_text: 'Взгляните на табличку' },
  media: {},
  completion: { mode: 'answer', acceptable: ['1730'] },
  supporting: { hint: { cost_coins: 5, reveal_text: 'Цифры выбиты в арке' } },
};

const hintlessStep: GameStep = { ...hintStep, supporting: {} };

describe('wrongAnswersAt', () => {
  it('counts only incorrect answer_submitted facts at the position', () => {
    const facts = [wrong(4, '1700'), correct(4, '1730'), wrong(3, 'x'), hintPurchase(4)];
    expect(wrongAnswersAt(facts, 4)).toBe(1);
    expect(wrongAnswersAt(facts, 3)).toBe(1);
    expect(wrongAnswersAt(facts, 0)).toBe(0);
  });
});

describe('shouldOfferHint', () => {
  it('does NOT offer on the first wrong answer (inline error only)', () => {
    expect(shouldOfferHint([wrong(4, '1700')], 4, hintStep)).toBe(false);
  });

  it('offers from the second wrong answer on a hint-bearing step', () => {
    expect(shouldOfferHint([wrong(4, '1700'), wrong(4, '1731')], 4, hintStep)).toBe(true);
    expect(shouldOfferHint([wrong(4, 'a'), wrong(4, 'b'), wrong(4, 'c')], 4, hintStep)).toBe(true);
  });

  it('never offers when the step has no hint', () => {
    expect(shouldOfferHint([wrong(4, 'a'), wrong(4, 'b')], 4, hintlessStep)).toBe(false);
  });

  it('never re-offers after the hint is purchased', () => {
    const facts = [wrong(4, 'a'), wrong(4, 'b'), hintPurchase(4), wrong(4, 'c')];
    expect(shouldOfferHint(facts, 4, hintStep)).toBe(false);
  });

  it('counts wrongs per step, not globally', () => {
    expect(shouldOfferHint([wrong(1, 'a'), wrong(4, 'b')], 4, hintStep)).toBe(false);
  });
});
