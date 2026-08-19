// @vitest-environment node
/**
 * The ONE game-rules engine (issue #65). Both players run these rules; the
 * suite pins them once: wrong-answer ordinals (the restart-dedup fix), the
 * hint offer threshold, gift-on-completion, the once-per-quest bonus,
 * overdraft-legal hint purchases, and advance clamping.
 */
import { describe, expect, it } from 'vitest';
import type { GameStep, OncePerQuestType } from '../shared-model';
import {
  COMMENT_BONUS,
  COMPLETION_BONUS,
  NO_EARNED_BONUSES,
  RATING_BONUS,
  initialPlayState,
  transition,
  type PlayCtx,
  type PlayState,
} from '../play-loop';

const answerStep = (over: Partial<GameStep> = {}): GameStep => ({
  position: 0,
  template: 'task_answer',
  rich_content: { title: 'q', main_text: '', button_text: 'Дальше' },
  media: {},
  completion: { mode: 'answer', acceptable: ['да'] },
  supporting: {
    hint: { cost_coins: 10, reveal_text: 'подсказка' },
    gift: null,
    navigator: null,
    terminal: false,
  },
  ...over,
});

const physicalStep = (over: Partial<GameStep> = {}): GameStep => ({
  position: 1,
  template: 'task_no',
  rich_content: { title: 'p', main_text: '', button_text: 'Сделал' },
  media: {},
  completion: { mode: 'physical' },
  supporting: { hint: null, gift: { coins: 5, narrative_text: 'дар' }, navigator: null, terminal: false },
  ...over,
});

const terminalStep = (over: Partial<GameStep> = {}): GameStep => ({
  position: 2,
  template: 'congrats',
  rich_content: { title: 'финал', main_text: '', button_text: 'Квест пройден' },
  media: {},
  completion: { mode: 'physical' },
  supporting: { hint: null, gift: null, navigator: null, terminal: true },
  ...over,
});

const ctx = (steps: GameStep[]): PlayCtx => ({
  steps,
  deviceId: 'device-t',
  universalAnswers: [],
  earnedBonuses: NO_EARNED_BONUSES,
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
    const c = ctx([physicalStep({ position: 0 }), answerStep({ position: 1 }), terminalStep({ position: 2 })]);
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

  it('landing on the terminal step completes once with the bonus', () => {
    const c = ctx([physicalStep({ position: 0 }), terminalStep({ position: 1 })]);
    const r = transition(initialPlayState(), { type: 'physical_confirm' }, c);
    expect(r.effects.appended.map((f) => f.type)).toEqual([
      'physical_confirmed',
      'gift_claimed',
      'attempt_completed',
      'completion_bonus',
    ]);
    expect(r.effects.appended[3].coins_delta).toBe(COMPLETION_BONUS);
    expect(r.state.stepIdx).toBe(1);
    // Idempotent: an explicit enter_terminal (hydrate onto the finale) appends
    // nothing on an already-completed log, and neither does a reread landing.
    const again = transition(r.state, { type: 'enter_terminal' }, c);
    expect(again.effects.appended).toEqual([]);
    const back = transition(r.state, { type: 'back' }, c).state;
    const reland = transition(back, { type: 'advance_to', to: 1 }, c);
    expect(reland.effects.appended).toEqual([]);
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

describe('§11 rating rewards', () => {
  const finale = () => ctx([terminalStep({ position: 0 })]);

  it('stars pay +5 once, a comment pays +5 more, with one coin toast', () => {
    const c = finale();
    const done = transition(initialPlayState(), { type: 'enter_terminal' }, c).state;
    const r = transition(done, { type: 'rate', value: 5, text: 'Класс!' }, c);
    expect(r.effects.appended.map((f) => f.type)).toEqual([
      'quest_rated',
      'rating_bonus',
      'comment_bonus',
    ]);
    expect(r.effects.appended[1].coins_delta).toBe(RATING_BONUS);
    expect(r.effects.appended[2].coins_delta).toBe(COMMENT_BONUS);
    expect(r.effects.appended[2].note).toBeNull(); // the text rides quest_rated only
    expect(r.effects.toast).toEqual({
      amount: RATING_BONUS + COMMENT_BONUS,
      narrative: 'За оценку и отзыв',
    });
  });

  it('star-only rating pays only the rating bonus; the comment pays later', () => {
    const c = finale();
    const done = transition(initialPlayState(), { type: 'enter_terminal' }, c).state;
    const starOnly = transition(done, { type: 'rate', value: 4, text: null }, c);
    expect(starOnly.effects.appended.map((f) => f.type)).toEqual(['quest_rated', 'rating_bonus']);
    expect(starOnly.effects.toast).toEqual({ amount: RATING_BONUS, narrative: 'За оценку' });
    const withText = transition(starOnly.state, { type: 'rate', value: 4, text: 'Дописал' }, c);
    expect(withText.effects.appended.map((f) => f.type)).toEqual(['quest_rated', 'comment_bonus']);
    expect(withText.effects.toast).toEqual({ amount: COMMENT_BONUS, narrative: 'За отзыв' });
  });

  it('re-rating never doubles a bonus already in the log', () => {
    const c = finale();
    const done = transition(initialPlayState(), { type: 'enter_terminal' }, c).state;
    const first = transition(done, { type: 'rate', value: 5, text: 'Класс!' }, c);
    const again = transition(first.state, { type: 'rate', value: 3, text: 'Передумал' }, c);
    expect(again.effects.appended.map((f) => f.type)).toEqual(['quest_rated']);
    expect(again.effects.toast).toBeNull();
  });
});

describe('once-ever bonuses are once per QUEST, not per attempt (#114)', () => {
  const withEarned = (steps: GameStep[], ...earned: OncePerQuestType[]): PlayCtx => ({
    ...ctx(steps),
    earnedBonuses: new Set(earned),
  });

  it('a replay of a finished quest completes without minting a second completion bonus', () => {
    const c = withEarned([physicalStep({ position: 0 }), terminalStep({ position: 1 })], 'completion_bonus');
    const r = transition(initialPlayState(), { type: 'physical_confirm' }, c);
    expect(r.effects.appended.map((f) => f.type)).toEqual([
      'physical_confirmed',
      'gift_claimed',
      'attempt_completed',
    ]);
    // The step gift IS re-earned every attempt (server keeps one per attempt),
    // so its toast still plays — only the once-per-quest bonus is withheld.
    expect(r.effects.toast).toEqual({ amount: 5, narrative: 'дар' });
  });

  it('a replay pays nothing for stars or a review already rewarded, and animates nothing', () => {
    const c = withEarned([terminalStep({ position: 0 })], 'rating_bonus', 'comment_bonus');
    const done = transition(initialPlayState(), { type: 'enter_terminal' }, c).state;
    const r = transition(done, { type: 'rate', value: 5, text: 'Ещё раз отлично' }, c);
    expect(r.effects.appended.map((f) => f.type)).toEqual(['quest_rated']);
    expect(r.effects.toast).toBeNull();
  });

  it('withholds only what was already earned — the unearned review bonus still pays', () => {
    const c = withEarned([terminalStep({ position: 0 })], 'rating_bonus');
    const done = transition(initialPlayState(), { type: 'enter_terminal' }, c).state;
    const r = transition(done, { type: 'rate', value: 5, text: 'Первый отзыв' }, c);
    expect(r.effects.appended.map((f) => f.type)).toEqual(['quest_rated', 'comment_bonus']);
    expect(r.effects.toast).toEqual({ amount: COMMENT_BONUS, narrative: 'За отзыв' });
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
