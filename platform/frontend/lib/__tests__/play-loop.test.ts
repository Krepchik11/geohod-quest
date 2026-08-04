// @vitest-environment node
/**
 * The ONE game-rules engine (issue #65). Both players run these rules; the
 * suite pins them once: wrong-answer ordinals (the restart-dedup fix), the
 * hint offer threshold, gift-on-completion, the once-per-quest bonus,
 * overdraft-legal hint purchases, and advance clamping.
 */
import { describe, expect, it } from 'vitest';
import type { GameStep } from '../shared-model';
import { initialPlayState, transition, type PlayCtx, type PlayState } from '../play-loop';

const answerStep = (over: Partial<GameStep> = {}): GameStep => ({
  position: 0,
  template: 'task_answer',
  rich_content: { title: 'q', body_text: '', button_text: 'Дальше', image: null },
  completion: { kind: 'answer', acceptable: ['да'] },
  supporting: {
    hint: { cost_coins: 10, reveal_text: 'подсказка', image: null },
    gift: null,
    navigator: null,
    terminal: false,
  },
  ...over,
} as GameStep);

const physicalStep = (over: Partial<GameStep> = {}): GameStep => ({
  position: 1,
  template: 'task_no',
  rich_content: { title: 'p', body_text: '', button_text: 'Сделал', image: null },
  completion: { kind: 'physical' },
  supporting: { hint: null, gift: { coins: 5, narrative_text: 'дар' }, navigator: null, terminal: false },
  ...over,
} as GameStep);

const terminalStep = (over: Partial<GameStep> = {}): GameStep => ({
  position: 2,
  template: 'congrats',
  rich_content: { title: 'финал', body_text: '', button_text: 'Квест пройден', image: null },
  completion: { kind: 'none' },
  supporting: { hint: null, gift: null, navigator: null, terminal: true },
  ...over,
} as GameStep);

const ctx = (steps: GameStep[]): PlayCtx => ({
  steps,
  deviceId: 'device-t',
  universalAnswers: [],
});

describe('answers and the wrong-answer ordinal', () => {
  it('a correct answer completes the step and advances', () => {
    const c = ctx([answerStep(), physicalStep()]);
    const { state, effects } = transition(initialPlayState(), { type: 'answer', value: 'да' }, c);
    expect(effects.appended.map((f) => f.type)).toEqual(['answer_submitted']);
    expect(effects.appended[0].local_is_correct).toBe(true);
    expect(state.stepIdx).toBe(1);
  });

  it('repeated identical wrong answers carry ordinals so restart dedup keeps them', () => {
    const c = ctx([answerStep(), physicalStep()]);
    let s = initialPlayState();
    const notes: Array<string | null | undefined> = [];
    for (let i = 0; i < 3; i += 1) {
      const r = transition(s, { type: 'answer', value: 'фонтан' }, c);
      s = r.state;
      notes.push(r.effects.appended[0].note);
    }
    // First wrong keeps note null (old logs stay compatible); repeats get #N.
    expect(notes).toEqual([null, 'wrong#2', 'wrong#3']);
    expect(s.stepIdx).toBe(0);
  });

  it('different wrong answers need no ordinal — their values already differ', () => {
    const c = ctx([answerStep(), physicalStep()]);
    let s = initialPlayState();
    s = transition(s, { type: 'answer', value: 'a' }, c).state;
    const r = transition(s, { type: 'answer', value: 'b' }, c);
    expect(r.effects.appended[0].note).toBeNull();
  });

  it('offers the hint from the SECOND wrong answer while unbought', () => {
    const c = ctx([answerStep(), physicalStep()]);
    let s = initialPlayState();
    s = transition(s, { type: 'answer', value: 'фонтан' }, c).state;
    expect(s.hintOfferPos).toBeNull();
    s = transition(s, { type: 'answer', value: 'фонтан' }, c).state;
    expect(s.hintOfferPos).toBe(0);
  });

  it('universal answers are accepted', () => {
    const c = { ...ctx([answerStep(), physicalStep()]), universalAnswers: ['сезам'] };
    const r = transition(initialPlayState(), { type: 'answer', value: 'сезам' }, c);
    expect(r.effects.appended[0].local_is_correct).toBe(true);
  });
});

describe('hints', () => {
  it('purchase is never blocked by balance and reveals the content', () => {
    const c = ctx([answerStep(), physicalStep()]);
    let s = initialPlayState();
    s = transition(s, { type: 'answer', value: 'x' }, c).state;
    s = transition(s, { type: 'answer', value: 'x' }, c).state;
    const r = transition(s, { type: 'buy_hint' }, c);
    const fact = r.effects.appended[0];
    expect(fact.type).toBe('hint_purchased');
    expect(fact.coins_delta).toBe(-10);
    expect(fact.note).toBe('подсказка');
    expect(r.state.hintOfferPos).toBeNull();
    expect(r.state.hintRevealPos).toBe(0);
    expect(r.effects.toast).toEqual({ amount: -10, narrative: 'подсказка' });
  });

  it('a second purchase on the same step is a no-op', () => {
    const c = ctx([answerStep(), physicalStep()]);
    let s = initialPlayState();
    s = transition(s, { type: 'buy_hint' }, c).state;
    const r = transition(s, { type: 'buy_hint' }, c);
    expect(r.effects.appended).toEqual([]);
  });
});

describe('gifts and completion', () => {
  it('physical confirm claims the gift once and advances', () => {
    const c = ctx([physicalStep({ position: 0 }), terminalStep({ position: 1 })]);
    const r = transition(initialPlayState(), { type: 'physical_confirm' }, c);
    expect(r.effects.appended.map((f) => f.type)).toEqual(['physical_confirmed', 'gift_claimed']);
    expect(r.effects.appended[1].coins_delta).toBe(5);
    expect(r.effects.toast).toEqual({ amount: 5, narrative: 'дар' });
    expect(r.state.stepIdx).toBe(1);
    // Re-confirming after a back-navigation never double-claims.
    const back = transition(r.state, { type: 'back' }, c).state;
    const again = transition(back, { type: 'physical_confirm' }, c);
    expect(again.effects.appended.map((f) => f.type)).toEqual(['physical_confirmed']);
  });

  it('entering the terminal completes once with the +5 bonus', () => {
    const steps = [physicalStep({ position: 0 }), terminalStep({ position: 1 })];
    const c = ctx(steps);
    const s = transition(initialPlayState(), { type: 'physical_confirm' }, c).state;
    const r = transition(s, { type: 'enter_terminal' }, c);
    expect(r.effects.appended.map((f) => f.type)).toEqual(['attempt_completed', 'completion_bonus']);
    expect(r.effects.appended[1].coins_delta).toBe(5);
    // Idempotent: entering again (reread) appends nothing.
    const again = transition(r.state, { type: 'enter_terminal' }, c);
    expect(again.effects.appended).toEqual([]);
  });

  it('no second bonus when the log already carries one (restart of a done quest)', () => {
    const steps = [terminalStep({ position: 0 })];
    const c = ctx(steps);
    const s: PlayState = {
      ...initialPlayState(),
      facts: [
        {
          type: 'completion_bonus', step_position: 0, submitted_value: null,
          local_is_correct: true, coins_delta: 5, note: 'Бонус за прохождение', device_id: 'other',
        },
      ],
    };
    const r = transition(s, { type: 'enter_terminal' }, c);
    expect(r.effects.appended.map((f) => f.type)).toEqual(['attempt_completed']);
  });
});

describe('navigation', () => {
  it('advance clamps to the last step; back clamps to the first', () => {
    const c = ctx([physicalStep({ position: 0 }), terminalStep({ position: 1 })]);
    let s = initialPlayState();
    s = transition(s, { type: 'advance_to', to: 99 }, c).state;
    expect(s.stepIdx).toBe(1);
    expect(s.maxStepIdx).toBe(1);
    s = transition(s, { type: 'back' }, c).state;
    s = transition(s, { type: 'back' }, c).state;
    expect(s.stepIdx).toBe(0);
    expect(s.maxStepIdx).toBe(1);
  });
});
