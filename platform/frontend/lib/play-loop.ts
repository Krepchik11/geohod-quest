/**
 * The ONE game-rules engine (issue #65): a pure transition over the fact log.
 * No React, no timers, no Date — both the real player (QuestPlayerClient) and
 * the constructor's test player run THESE rules; neither re-implements them.
 *
 * State is derived from facts wherever a rule needs history (wrong counts,
 * idempotency guards), so a restore from the queue replays into exactly the
 * same behavior as live play.
 */
import {
  isAnswerAccepted,
  shouldOfferHint,
  type Fact,
  type GameStep,
} from './shared-model';

export interface PlayState {
  facts: Fact[];
  /** Array-index step identity (see QuestPlayerClient's PlayerState note). */
  stepIdx: number;
  /** Furthest step ever reached this attempt — resume anchor, back-safe. */
  maxStepIdx: number;
  /** Step whose hint offer popup is open (from the 2nd wrong answer only). */
  hintOfferPos: number | null;
  /** Step whose just-purchased hint content popup is open. */
  hintRevealPos: number | null;
}

export interface PlayEffects {
  /** Facts this transition appended (already inside state.facts) — sink these. */
  appended: Fact[];
  /** Designed coin toast: positive = gift/bonus, negative = spend. */
  toast: { amount: number; narrative?: string } | null;
  /** stepIdx moved forward (the caller pushes history / clears the input). */
  advanced: boolean;
  /** The navigator handoff target, when the event was `navigator`. */
  openMaps: { lat: number; lng: number } | null;
}

export interface PlayCtx {
  steps: GameStep[];
  deviceId: string;
  /** Universal answers in effect: the snapshot's and the platform-wide one. */
  universalAnswers: Array<string | null | undefined>;
}

export type PlayEvent =
  | { type: 'physical_confirm' }
  | { type: 'answer'; value: string }
  | { type: 'buy_hint' }
  | { type: 'dismiss_hint_offer' }
  | { type: 'dismiss_hint_reveal' }
  | { type: 'enter_terminal' }
  | { type: 'feedback'; note: string }
  | { type: 'navigator' }
  | { type: 'rate'; value: number; text: string | null }
  | { type: 'advance_to'; to: number }
  | { type: 'back' };

export function initialPlayState(): PlayState {
  return { facts: [], stepIdx: 0, maxStepIdx: 0, hintOfferPos: null, hintRevealPos: null };
}

/** A hydrated state over restored facts (queue restore / test-player reset). */
export function hydratedPlayState(facts: Fact[], stepIdx: number): PlayState {
  return { ...initialPlayState(), facts, stepIdx, maxStepIdx: stepIdx };
}

const NO_EFFECTS: PlayEffects = { appended: [], toast: null, advanced: false, openMaps: null };

interface Builder {
  state: PlayState;
  effects: PlayEffects;
  ctx: PlayCtx;
}

function append(b: Builder, partial: Omit<Fact, 'device_id'>): Fact {
  const fact: Fact = { ...partial, device_id: b.ctx.deviceId };
  b.state = { ...b.state, facts: [...b.state.facts, fact] };
  b.effects = { ...b.effects, appended: [...b.effects.appended, fact] };
  return fact;
}

function advanceTo(b: Builder, to: number): void {
  const clamped = Math.max(0, Math.min(to, b.ctx.steps.length - 1));
  if (clamped === b.state.stepIdx) return;
  b.effects = { ...b.effects, advanced: clamped > b.state.stepIdx };
  b.state = {
    ...b.state,
    stepIdx: clamped,
    maxStepIdx: Math.max(b.state.maxStepIdx, clamped),
  };
}

/** Gift is claimed when its step COMPLETES (confirm / correct answer / terminal),
 *  never on reach; idempotent over the whole fact log. */
function claimGiftIfNeeded(b: Builder, pos: number): void {
  const gift = b.ctx.steps[pos]?.supporting?.gift;
  if (!gift) return;
  if (b.state.facts.some((f) => f.type === 'gift_claimed' && f.step_position === pos)) return;
  append(b, {
    type: 'gift_claimed',
    step_position: pos,
    submitted_value: null,
    local_is_correct: true,
    coins_delta: gift.coins,
    note: gift.narrative_text || null,
  });
  b.effects = { ...b.effects, toast: { amount: gift.coins, narrative: gift.narrative_text ?? undefined } };
}

/**
 * Ordinal for a repeated identical wrong answer: «wrong#2» from the second
 * repeat on this step. The queue and the backend dedup facts by natural key,
 * which would otherwise collapse identical wrongs into one on restore — the
 * hint offer then arrived one mistake late (the issue #65 live bug). The first
 * wrong keeps note=null, so old logs stay compatible and the natural-key rule
 * itself never changes.
 */
function wrongNote(facts: Fact[], pos: number, value: string): string | null {
  const repeats = facts.filter(
    (f) =>
      f.type === 'answer_submitted' &&
      f.step_position === pos &&
      !f.local_is_correct &&
      f.submitted_value === value,
  ).length;
  return repeats === 0 ? null : `wrong#${repeats + 1}`;
}

export function transition(
  state: PlayState,
  event: PlayEvent,
  ctx: PlayCtx,
): { state: PlayState; effects: PlayEffects } {
  const b: Builder = { state, effects: NO_EFFECTS, ctx };
  const step = ctx.steps[state.stepIdx];

  switch (event.type) {
    case 'physical_confirm': {
      append(b, {
        type: 'physical_confirmed',
        step_position: state.stepIdx,
        submitted_value: null,
        local_is_correct: true,
        coins_delta: 0,
        note: null,
      });
      claimGiftIfNeeded(b, state.stepIdx);
      advanceTo(b, state.stepIdx + 1);
      break;
    }

    case 'answer': {
      const value = event.value;
      if (!value.trim()) break;
      const correct = isAnswerAccepted(
        value,
        (step.completion as { acceptable?: string[] }).acceptable ?? [],
        ctx.universalAnswers,
      );
      append(b, {
        type: 'answer_submitted',
        step_position: state.stepIdx,
        submitted_value: value,
        local_is_correct: correct,
        coins_delta: 0,
        note: correct ? null : wrongNote(state.facts, state.stepIdx, value),
      });
      if (!correct) {
        // Inline error on the 1st wrong; the popup only from the 2nd while unbought.
        if (shouldOfferHint(b.state.facts, state.stepIdx, step)) {
          b.state = { ...b.state, hintOfferPos: state.stepIdx };
        }
        break;
      }
      claimGiftIfNeeded(b, state.stepIdx);
      advanceTo(b, state.stepIdx + 1);
      break;
    }

    case 'buy_hint': {
      const pos = state.hintOfferPos ?? state.stepIdx;
      const hint = ctx.steps[pos]?.supporting?.hint;
      if (!hint) break;
      // Idempotent per step; never blocked by balance — overdraft is legal.
      if (state.facts.some((f) => f.type === 'hint_purchased' && f.step_position === pos)) {
        b.state = { ...b.state, hintOfferPos: null };
        break;
      }
      append(b, {
        type: 'hint_purchased',
        step_position: pos,
        submitted_value: null,
        local_is_correct: true,
        coins_delta: -(hint.cost_coins ?? 0),
        note: hint.reveal_text || null,
      });
      b.state = { ...b.state, hintOfferPos: null, hintRevealPos: pos };
      if (hint.cost_coins) {
        b.effects = { ...b.effects, toast: { amount: -hint.cost_coins, narrative: 'подсказка' } };
      }
      break;
    }

    case 'dismiss_hint_offer':
      b.state = { ...b.state, hintOfferPos: null };
      break;

    case 'dismiss_hint_reveal':
      b.state = { ...b.state, hintRevealPos: null };
      break;

    case 'enter_terminal': {
      if (state.facts.some((f) => f.type === 'attempt_completed')) break;
      append(b, {
        type: 'attempt_completed',
        step_position: state.stepIdx,
        submitted_value: null,
        local_is_correct: true,
        coins_delta: 0,
        note: step.rich_content.button_text || 'Квест пройден',
      });
      if (!state.facts.some((f) => f.type === 'completion_bonus')) {
        append(b, {
          type: 'completion_bonus',
          step_position: state.stepIdx,
          submitted_value: null,
          local_is_correct: true,
          coins_delta: 5,
          note: 'Бонус за прохождение',
        });
        b.effects = { ...b.effects, toast: { amount: 5, narrative: 'Бонус за прохождение' } };
      }
      claimGiftIfNeeded(b, state.stepIdx);
      break;
    }

    case 'feedback':
      append(b, {
        type: 'feedback_reported',
        step_position: state.stepIdx,
        submitted_value: null,
        local_is_correct: true,
        coins_delta: 0,
        note: event.note || null,
      });
      break;

    case 'navigator': {
      const nav = step.supporting?.navigator;
      if (!nav) break;
      append(b, {
        type: 'navigator_used',
        step_position: state.stepIdx,
        submitted_value: null,
        local_is_correct: true,
        coins_delta: 0,
        note: nav.label || null,
      });
      b.effects = { ...b.effects, openMaps: { lat: nav.lat, lng: nav.lng } };
      break;
    }

    case 'rate': {
      const text = event.text?.trim().slice(0, 500) || null;
      // Re-append when the score OR the text is new; identical repeats are
      // absorbed by natural-key dedup anyway.
      const last = [...state.facts].reverse().find((f) => f.type === 'quest_rated');
      if (event.value <= 0 || (last && Number(last.submitted_value) === event.value && !text)) break;
      append(b, {
        type: 'quest_rated',
        step_position: state.stepIdx,
        submitted_value: String(event.value),
        local_is_correct: true,
        coins_delta: 0,
        note: text,
      });
      break;
    }

    case 'advance_to':
      advanceTo(b, event.to);
      break;

    case 'back':
      advanceTo(b, state.stepIdx - 1);
      break;
  }

  return { state: b.state, effects: b.effects };
}
