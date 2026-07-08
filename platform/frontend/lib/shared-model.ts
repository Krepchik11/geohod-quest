/**
 * Technology-agnostic shared model for GeoQuest, mirroring blueprint/SPEC.md.
 *
 * Home of the wire types (QuestSnapshot, GameStep, Fact, AccessGrant) and the pure
 * deterministic projectors (projectState/projectBalance/latestRating). The
 * projectors MUST match the Rust backend fold for identical input — the shared
 * fixtures in platform/goldens/parity/ are executed by both this suite and the
 * backend's. All coin amounts are frozen in the snapshot at publish time.
 */

export interface RichContent {
  title: string;
  main_text: string;
  place_text?: string;
  button_text?: string;
  question_prompt?: string | null;
  gift_narrative?: string | null;
  hint_reveal_text?: string | null;
}

/** Inline video reference frozen in the snapshot (video / route_video templates). */
export interface MediaVideo {
  ref?: string | null;
  duration_label?: string | null;
  caption?: string | null;
}

export interface Media {
  task?: string | null;
  character?: string | null;
  hint?: string | null; // coin-gated
  atmosphere?: string | null;
  video?: MediaVideo | null;
}

export interface Completion {
  mode: 'physical' | 'answer';
  acceptable?: string[] | null; // only for answer; plain list from constructor
  // NOTE: frozen snapshots published before the note feature was retired still
  // carry an `allow_note` boolean here — the player ignores it.
}

export interface Gift {
  coins: number;
  narrative_text: string;
}

export interface Hint {
  cost_coins: number;
  reveal_text?: string;
  reveal_geo?: boolean;
}

export interface Navigator {
  lat: number;
  lng: number;
  label?: string;
  hint_only?: boolean;
  shortest_route_hint?: boolean;
}

export interface BonusAnimation {
  asset_ref: string;
  voice_ref?: string;
}

export interface PhysicalAction {
  description: string;
  confirm_label?: string;
}

export interface Supporting {
  gift?: Gift | null;
  hint?: Hint | null;
  navigator?: Navigator | null;
  bonus_animation?: BonusAnimation | null;
  physical_action?: PhysicalAction | null;
  terminal?: boolean | null;
  narrative_advance?: boolean | null;
  is_start?: boolean | null;
  media_video?: string | null;
}

export interface GameStep {
  position: number | null;
  template: 'start' | 'video' | 'task_no' | 'task_answer' | 'continue' | 'route_video' | 'congrats';
  /** Structured rich-text shape (SPEC). `rich_content` is the rendered-by-the-player
   *  alias both the goldens and the constructor currently populate. */
  content?: Record<string, unknown>;
  rich_content: RichContent;
  media: Media;
  completion: Completion;
  supporting?: Supporting;
}

export interface QuestSnapshot {
  golden_id: string;
  name: string;
  snapshot_version: number;
  steps: GameStep[];
  notes?: string;
  /** Author's store-card city, frozen into the snapshot so the player shows the
   *  real place instead of a hardcoded default. Optional: snapshots published
   *  before this field carry no city and the player simply omits it. */
  city?: string;
  /** Author's store-card duration label, frozen alongside `city`. */
  duration?: string;
}

export interface Fact {
  type: 'physical_confirmed' | 'answer_submitted' | 'gift_claimed' | 'attempt_completed' | 'hint_purchased' | 'completion_bonus' | 'feedback_reported' | 'navigator_used' | 'quest_rated';
  step_position: number;
  submitted_value?: string | null;
  local_is_correct: boolean;
  coins_delta: number;
  note?: string | null;
  device_id: string;
}

export interface PlaythroughGolden {
  golden_id: string;
  quest_snapshot_id: string;
  description: string;
  actions: Array<{
    step_position: number;
    type: 'physical_confirm' | 'submit_answer';
    value?: string | null;
    note?: string | null;
    device_id: string;
    local_ts: number;
    local_is_correct: boolean;
  }>;
  expected_facts: Fact[];
  expected_final_balance: number;
  expected_revealed: unknown[];
  notes?: string;
}

// Helper type for facts projection (deterministic fold)
export interface ProjectedState {
  completedSteps: number[];
  balance: number;
  revealedHints: number[];
  // Extend for full attempt state per design
}

/** Basic pure loader for goldens (JSON -> typed). No side effects. */
export function loadQuestSnapshot(data: unknown): QuestSnapshot {
  // Minimal runtime guard for TDD; full validation in validateForPublish
  if (typeof data !== 'object' || data === null || !('steps' in data)) {
    throw new Error('Invalid QuestSnapshot JSON');
  }
  return data as QuestSnapshot;
}

export function loadPlaythroughGolden(data: unknown): PlaythroughGolden {
  if (typeof data !== 'object' || data === null || !('actions' in data)) {
    throw new Error('Invalid PlaythroughGolden JSON');
  }
  return data as PlaythroughGolden;
}

/**
 * Exact answer matching: membership in the acceptable list after trim + lowercase
 * (no substring, no fuzzy normalization — per the locked SPEC decision). The single
 * source of truth shared by the constructor's test box, the player's submit, the
 * goldens, and the bundle validator. Mirrors design/player/matcher.js.
 */
export function isAnswerCorrect(submitted: string, acceptable: string[] | null | undefined): boolean {
  const norm = (s: string) => String(s).trim().toLowerCase();
  if (!submitted || !String(submitted).trim()) return false;
  return (acceptable || []).some((a) => norm(a) === norm(submitted));
}

/**
 * Pure validateForPublish: checks draft against goldens structure + SPEC gates.
 * e.g. Task templates need primary media/task-ish, answer steps need >=1 acceptable.
 * estBundleMB stubbed (real size est in later ctor).
 */
export function validateForPublish(draft: unknown): { errors: string[]; warnings: string[]; estBundleMB?: number } {
  const errors: string[] = [];
  const warnings: string[] = [];
  const d = draft as { steps?: unknown };
  if (!d || !Array.isArray(d.steps)) {
    errors.push('Draft must have steps array');
    return { errors, warnings };
  }
  (d.steps as unknown as Record<string, unknown>[]).forEach((step: Record<string, unknown>, i: number) => {
    const tmpl = step.template as string;
    const media = step.media as { task?: unknown; } | undefined;
    const rich = step.rich_content as { main_text?: unknown; } | undefined;
    const comp = step.completion as { acceptable?: unknown[]; mode?: string; } | undefined;
    if (['task_no', 'task_answer'].includes(tmpl) && !media?.task && !rich?.main_text) {
      errors.push(`Step ${i}: Task templates require primary media/task or main_text (per gates)`);
    }
    if (tmpl === 'task_answer' && (!comp?.acceptable || ((comp.acceptable as unknown[]) || []).length === 0)) {
      errors.push(`Step ${i}: answer task must have >=1 acceptable`);
    }
    if (comp?.mode === 'physical' && ((comp.acceptable as unknown[]) || []).length) {
      warnings.push(`Step ${i}: physical with acceptable list? (possible mode mismatch)`);
    }
  });
  return { errors, warnings, estBundleMB: 0 /* stub; real in bundle packer */ };
}

/** Pure serialize: deep-clone a draft into the frozen snapshot shape for publish. */
export function serializeToSnapshot(draft: unknown): QuestSnapshot {
  const d = draft as { steps?: unknown; golden_id?: string; name?: string; snapshot_version?: number };
  if (!d?.steps) throw new Error('Invalid draft for serialize');
  return {
    golden_id: d.golden_id || 'draft',
    name: d.name || 'Draft Quest',
    snapshot_version: (d.snapshot_version || 0) + 1,
    steps: JSON.parse(JSON.stringify(d.steps)), // deep clone for freeze
    notes: 'Serialized from draft (goldens-driven)'
  } as QuestSnapshot;
}

/** Deterministic balance: plain signed sum of coins_delta. May be negative (SPEC). */
export function projectBalance(facts: Fact[]): number {
  return facts.reduce((bal, f) => bal + (f.coins_delta || 0), 0);
}

/**
 * Deterministic projectState: fold facts to completed steps, revealed hints, balance.
 * A step is completed by physical_confirmed, attempt_completed, or a CORRECT answer_submitted —
 * wrong answers never complete a step (otherwise the attempt-advance offer would fire off a miss).
 * Must match the Rust project_state exactly (parity goldens enforce).
 */
export function projectState(facts: Fact[]): ProjectedState {
  const completedSteps: number[] = [];
  const revealedHints: number[] = [];
  let balance = 0;
  facts.forEach(f => {
    balance += f.coins_delta || 0;
    if (
      f.type === 'physical_confirmed' ||
      f.type === 'attempt_completed' ||
      (f.type === 'answer_submitted' && f.local_is_correct)
    ) {
      completedSteps.push(f.step_position);
    } else if (f.type === 'hint_purchased') {
      revealedHints.push(f.step_position);
    }
  });
  return {
    completedSteps: [...new Set(completedSteps)].sort((a, b) => a - b),
    balance,
    revealedHints: [...new Set(revealedHints)].sort((a, b) => a - b)
  };
}

/** Count of incorrect answer submissions at a step (pure fold over the fact log). */
export function wrongAnswersAt(facts: Fact[], pos: number): number {
  return facts.filter(
    (f) => f.type === 'answer_submitted' && !f.local_is_correct && f.step_position === pos
  ).length;
}

/**
 * The player's quest rating for this attempt: the value (1–5) of the LAST
 * `quest_rated` fact, or 0 if the player never rated. Append-only "last wins" —
 * changing the rating appends a new fact, never mutates the old one. A rating fact
 * carries coins_delta 0 and completes/reveals nothing, so it is a projection no-op
 * for balance/state (parity golden: with-quest-rating). Used to rehydrate the
 * final screen's stars and to aggregate ratings for the author.
 */
export function latestRating(facts: Fact[]): number {
  let rating = 0;
  for (const f of facts) {
    if (f.type === 'quest_rated') {
      const n = Number(f.submitted_value);
      if (Number.isFinite(n)) rating = n;
    }
  }
  return rating;
}

/**
 * SPEC §Wrong-Answer / Hint Flow: the hint popup is offered only from the SECOND
 * wrong answer on a step, only while the step carries a hint that has not been
 * purchased yet. Derived from the fact log alone — no parallel counter state.
 */
export function shouldOfferHint(facts: Fact[], pos: number, step: GameStep): boolean {
  if (!step.supporting?.hint) return false;
  if (projectState(facts).revealedHints.includes(pos)) return false;
  return wrongAnswersAt(facts, pos) >= 2;
}

/** Balance re-projection notice: show «Баланс обновлён» old → new (SPEC correction 1). */
export interface BalanceNotice {
  old: number;
  new: number;
}

/** Attempt-advance offer: continue from the farther step reached elsewhere (SPEC correction 2). */
export interface AdvanceOffer {
  local_step: number;
  server_step: number;
}

/** The two SPEC sync corrections, derived client-side. Absent field = nothing to show. */
export interface SyncCorrections {
  balanceNotice?: BalanceNotice;
  advanceOffer?: AdvanceOffer;
}

/**
 * Pure deriveSyncCorrections: the ONLY source of correction UI events (no correction facts exist).
 * Diff the pre-sync local projection against the post-sync authoritative projection:
 * - balances differ -> balance re-projection notice {old, new};
 * - authoritative furthest completed step exceeds local -> advance offer.
 * Steps are never lost (facts union), so only forward advance is offered.
 */
export function deriveSyncCorrections(local: ProjectedState, authoritative: ProjectedState): SyncCorrections {
  const corrections: SyncCorrections = {};
  if (local.balance !== authoritative.balance) {
    corrections.balanceNotice = { old: local.balance, new: authoritative.balance };
  }
  const furthest = (s: ProjectedState) => (s.completedSteps.length ? s.completedSteps[s.completedSteps.length - 1] : -1);
  const localStep = furthest(local);
  const serverStep = furthest(authoritative);
  if (serverStep > localStep) {
    corrections.advanceOffer = { local_step: localStep, server_step: serverStep };
  }
  return corrections;
}

/**
 * A lifetime ownership record (the client mirror of the backend AccessGrant): one
 * player's access to one quest. Idempotent by (player_id, quest_id) — source is
 * audit-only, first wins. Survives version publishes and gates attempt creation.
 */
export interface AccessGrant {
  player_id: string;
  quest_id: string;
  granted_at: string;
  source: 'Payment' | 'CouponRedemption' | 'FreeQuest' | 'Admin';
  source_ref?: string | null;
}

/**
 * Pure idempotent grant decision mirroring the backend helper: return the existing
 * grant for (player, quest) unchanged (first source preserved), else a new one
 * stamped with the current ISO timestamp. Deterministic and side-effect-free.
 */
export function createGrantIdemp(existing: AccessGrant | null, player: string, quest: string, source: AccessGrant['source']): {grant: AccessGrant; created: boolean} {
  if (existing && existing.player_id === player && existing.quest_id === quest) {
    return { grant: existing, created: false };
  }
  const grant: AccessGrant = {
    player_id: player,
    quest_id: quest,
    granted_at: new Date().toISOString(),
    source,
    source_ref: null,
  };
  return { grant, created: true };
}

/** isEligibleForAttempt (pure): (grant && grant.quest_id === quest_id) || !!is_free_quest. */
export function isEligibleForAttempt(grant: AccessGrant | null, quest_id: string, is_free_quest?: boolean): boolean {
  return (grant && grant.quest_id === quest_id) || !!is_free_quest;
}