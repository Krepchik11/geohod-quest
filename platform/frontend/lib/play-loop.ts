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
  latestRating,
  wrongPopupAt,
  type Fact,
  type GameStep,
  type OncePerQuestType,
} from './shared-model';

/** The canonical once-per-quest completion bonus (SPEC). */
export const COMPLETION_BONUS = 5;
/** §11: once-ever rewards for the finale — stars and a written review. Once
 *  per (player, quest), like the completion bonus: see `awardOnce`. */
export const RATING_BONUS = 5;
export const COMMENT_BONUS = 5;

/** The ONE terminal predicate — both players and the engine share it. */
export function isTerminalStep(step: GameStep): boolean {
  return !!step.supporting?.terminal || step.template === 'congrats';
}

export interface PlayState {
  facts: Fact[];
  /** Array-index step identity (see QuestPlayerClient's PlayerState note). */
  stepIdx: number;
  /** Furthest step ever reached this attempt — resume anchor, back-safe. */
  maxStepIdx: number;
  /** Step whose wrong-answer popup is open (after every wrong answer on an answer
   *  step; its content is `wrongPopupAt`'s call). Named from the days the popup
   *  only sold the hint — kept to keep the diff small. */
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
  openMaps: { lat: number; lng: number; label: string | null } | null;
  /** The verdict of an `answer` event (null for every other event / blank input). */
  answered: { correct: boolean } | null;
}

export interface PlayCtx {
  steps: GameStep[];
  deviceId: string;
  /** Universal answers in effect: the snapshot's and the platform-wide one. */
  universalAnswers: Array<string | null | undefined>;
  /** Bonuses this quest already paid on an earlier attempt — see `awardOnce`
   *  (lib/player-stats.earnedQuestBonuses reads them). */
  earnedBonuses: ReadonlySet<OncePerQuestType>;
  /** What «Пропустить задание» costs in this quest (lib/snapshot.skipCost). */
  skipCost: number;
}

export const NO_EARNED_BONUSES: ReadonlySet<OncePerQuestType> = new Set();

export type PlayEvent =
  | { type: 'physical_confirm' }
  | { type: 'answer'; value: string }
  | { type: 'buy_hint' }
  | { type: 'skip_task' }
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

const NO_EFFECTS: PlayEffects = Object.freeze({
  appended: [],
  toast: null,
  advanced: false,
  openMaps: null,
  answered: null,
});

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
  // Landing on the terminal step IS completion — the engine owns the rule, so
  // neither player needs a follow-up enter_terminal after an advance.
  if (isTerminalStep(b.ctx.steps[clamped])) completeAttempt(b);
}

/** attempt_completed + once-per-log bonus + the terminal step's gift.
 *  Idempotent over the whole fact log (reread / rehydrate appends nothing). */
function completeAttempt(b: Builder): void {
  if (b.state.facts.some((f) => f.type === 'attempt_completed')) return;
  const pos = b.state.stepIdx;
  const step = b.ctx.steps[pos];
  append(b, {
    type: 'attempt_completed',
    step_position: pos,
    submitted_value: null,
    local_is_correct: true,
    coins_delta: 0,
    note: step.rich_content.button_text || 'Квест пройден',
  });
  if (awardOnce(b, 'completion_bonus', COMPLETION_BONUS, 'Бонус за прохождение')) {
    b.effects = { ...b.effects, toast: { amount: COMPLETION_BONUS, narrative: 'Бонус за прохождение' } };
  }
  claimGiftIfNeeded(b, pos);
}

/**
 * Append a once-ever bonus fact unless this player already holds it for this
 * quest; true when awarded. Once per (player, quest) is what the wallet and the
 * server mean too, so a replay is paid nothing and animates nothing (#114).
 * Bonus facts never carry free text beyond a fixed label: the note is part of
 * the natural key, so variable text would mint a fresh fact on every change.
 */
function awardOnce(
  b: Builder,
  type: OncePerQuestType,
  coins: number,
  note: string | null,
): boolean {
  if (b.ctx.earnedBonuses.has(type) || b.state.facts.some((f) => f.type === type)) return false;
  append(b, {
    type,
    step_position: b.state.stepIdx,
    submitted_value: null,
    local_is_correct: true,
    coins_delta: coins,
    note,
  });
  return true;
}

/** Gift is claimed when its step COMPLETES (confirm / correct answer / terminal),
 *  never on reach; idempotent over the whole fact log. A skipped step never pays
 *  it — not even when the player comes back and enters the right answer later:
 *  the gift rewards an answer found, not one bought. */
function claimGiftIfNeeded(b: Builder, pos: number): void {
  const gift = b.ctx.steps[pos]?.supporting?.gift;
  if (!gift) return;
  if (b.state.facts.some((f) => f.step_position === pos && (f.type === 'gift_claimed' || f.type === 'task_skipped'))) return;
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
      const correct = isAnswerAccepted(value, step.completion.acceptable, ctx.universalAnswers);
      b.effects = { ...b.effects, answered: { correct } };
      append(b, {
        type: 'answer_submitted',
        step_position: state.stepIdx,
        submitted_value: value,
        local_is_correct: correct,
        coins_delta: 0,
        note: correct ? null : wrongNote(state.facts, state.stepIdx, value),
      });
      if (!correct) {
        // Every wrong answer: the inline error AND the popup — what the popup
        // holds is wrongPopupAt's call, never restated here.
        if (wrongPopupAt(b.state.facts, state.stepIdx, step)) {
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

    case 'skip_task': {
      // Only from the open wrong-answer popup: no mistake on the step, no skip.
      const pos = state.hintOfferPos;
      if (pos == null) break;
      const popup = wrongPopupAt(state.facts, pos, ctx.steps[pos]);
      if (!popup) break;
      b.state = { ...b.state, hintOfferPos: null };
      // A step already completed (the player came back with «Назад») only moves
      // on — no fact, no charge — which also makes a repeated skip idempotent.
      if (!popup.freeSkip) {
        const cost = ctx.skipCost;
        const acceptable = ctx.steps[pos].completion.acceptable ?? [];
        append(b, {
          type: 'task_skipped',
          step_position: pos,
          // The substituted right answer: the first non-blank acceptable one.
          submitted_value: acceptable.map((a) => a.trim()).find(Boolean) ?? null,
          local_is_correct: true,
          // Never −0: a free skip must read as a plain 0 everywhere.
          coins_delta: cost ? -cost : 0,
          note: null,
        });
        // NO claimGiftIfNeeded: the step gift rewards an answer found, and a
        // skipped step never earns it — the one difference from a real answer.
        // Never blocked by balance — overdraft is legal, as with a hint.
        if (cost) {
          b.effects = { ...b.effects, toast: { amount: -cost, narrative: 'пропуск задания' } };
        }
      }
      advanceTo(b, pos + 1);
      break;
    }

    case 'dismiss_hint_offer':
      b.state = { ...b.state, hintOfferPos: null };
      break;

    case 'dismiss_hint_reveal':
      b.state = { ...b.state, hintRevealPos: null };
      break;

    // Hydrate/start ON the finale: no advance lands there, so the caller fires
    // this explicitly. Same guarded logic as an advance landing.
    case 'enter_terminal':
      completeAttempt(b);
      break;

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
      b.effects = { ...b.effects, openMaps: { lat: nav.lat, lng: nav.lng, label: nav.label || null } };
      break;
    }

    case 'rate': {
      const text = event.text?.trim().slice(0, 500) || null;
      // Re-append when the score OR the text is new; identical repeats are
      // absorbed by natural-key dedup anyway.
      if (event.value <= 0 || (latestRating(state.facts) === event.value && !text)) break;
      append(b, {
        type: 'quest_rated',
        step_position: state.stepIdx,
        submitted_value: String(event.value),
        local_is_correct: true,
        coins_delta: 0,
        note: text,
      });
      // §11 rewards (see awardOnce for the once-ever contract).
      const gotRating = awardOnce(b, 'rating_bonus', RATING_BONUS, null);
      const gotComment = !!text && awardOnce(b, 'comment_bonus', COMMENT_BONUS, null);
      if (gotRating || gotComment) {
        b.effects = {
          ...b.effects,
          toast: {
            amount: (gotRating ? RATING_BONUS : 0) + (gotComment ? COMMENT_BONUS : 0),
            narrative:
              gotRating && gotComment ? 'За оценку и отзыв' : gotComment ? 'За отзыв' : 'За оценку',
          },
        };
      }
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
