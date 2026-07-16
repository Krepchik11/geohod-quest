'use client';

import React, { useReducer, useEffect, useCallback, useMemo, useState, useRef } from 'react';
import { useRouter } from 'next/navigation';
import type { Fact, GameStep, QuestSnapshot } from '../../lib/shared-model';
import {
  isAnswerCorrect,
  projectState,
  shouldOfferHint,
  latestRating,
} from '../../lib/shared-model';
import { foldLocalPlayerStats, gatherOtherAttemptLogs, type AttemptLog } from '../../lib/player-stats';
import { toDesignStep } from '../../lib/design-step';
import { api, type PublishedQuestWire } from '../../lib/api';
import { nextQuestsForCatalog } from '../../lib/catalog';
import {
  factNaturalKey,
  ensureActiveAttempt,
  getFacts,
  setLastStepIdx,
  openAttempt,
  migrateLegacyLocalStorage,
  appendFact as queueAppendFact,
} from '../../lib/queue';
import { flushPending } from '../../lib/sync';
import { currentPlayerId, getDeviceId } from '../../lib/identity';
import { useClientFeature } from '../../lib/client-features';
import { StartGate } from './StartGate';
import { coinChime, spendChime } from './sound';
import { useOnline } from './useOnline';
import { useHistoryBackTrap } from './useHistoryBackTrap';
import { useKeyboardInset } from './useKeyboardInset';
import {
  PlayerFrame, StepView, TopBar, CoinToast, PCheck,
  HintPopup, HintRevealPopup, MenuOverlay, FeedbackSheet, CatalogScreen,
} from '../player/PlayerComponents';

/** RU copy, classic tone — shared with the constructor preview/test player. */
import { PLAYER_COPY as COPY } from '../../lib/player-copy';

const SOUND_PREF_KEY = 'geohod-player-sound:v1';
const TOAST_MS = 1900;

/** Sound preference (default on). `localStorage` throws in private mode / when
 *  storage is disabled, and a preference must never crash play — so both the read
 *  (in the lazy reducer init) and the write fail soft. */
function readSoundOn(): boolean {
  if (typeof window === 'undefined') return true;
  try {
    return localStorage.getItem(SOUND_PREF_KEY) !== 'off';
  } catch {
    return true;
  }
}
function persistSoundOn(on: boolean): void {
  try {
    localStorage.setItem(SOUND_PREF_KEY, on ? 'on' : 'off');
  } catch {
    /* best-effort; play continues with the in-memory value */
  }
}

/** Elapsed attempt time as the design's h:mm stat (e.g. «1:24»). */
function formatElapsed(createdAt: string | null): string {
  if (!createdAt) return '0:00';
  const ms = Math.max(0, Date.now() - new Date(createdAt).getTime());
  const minutes = Math.floor(ms / 60_000);
  return `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')}`;
}

interface PlayerState {
  facts: Fact[];
  stepIdx: number;
  /** Furthest step ever reached this attempt. The resume position persists THIS
   *  (not stepIdx), so a back-navigation reread never regresses where the
   *  player resumes after a restart. */
  maxStepIdx: number;
  /* Local attempt identity from the IndexedDB queue (server id lives there too). */
  attemptKey: string | null;
  attemptCreatedAt: string | null;
  /* Per-fact queue status mirror (natural key → status). Internal only: it drives
     the debounced silent flush (pending → 0 ends the loop); never rendered. */
  queueStatus: Record<string, 'pending' | 'sent'>;
  /* Start gate (SPEC): shown when an in-progress attempt was hydrated. */
  showStartGate: boolean;
  /** Step whose hint popup is open (SPEC: from the 2nd wrong answer only). */
  hintOfferPos: number | null;
  /** Step whose just-purchased hint content popup (text/image) is open. */
  hintRevealPos: number | null;
  /** Designed coin toast: positive = gift/bonus, negative = spend. */
  toast: { amount: number; narrative?: string } | null;
}

type PlayerAction =
  | { type: 'append'; fact: Fact }
  | { type: 'advance'; to: number }
  | {
      type: 'hydrate';
      facts: Fact[];
      stepIdx: number;
      attemptKey: string;
      attemptCreatedAt: string;
      queueStatus: Record<string, 'pending' | 'sent'>;
      showStartGate: boolean;
    }
  | { type: 'dismissStartGate' }
  | { type: 'setQueueStatus'; status: Record<string, 'pending' | 'sent'> }
  | { type: 'offerHint'; pos: number | null }
  | { type: 'revealHint'; pos: number | null }
  | { type: 'setToast'; toast: PlayerState['toast'] };

const initialState: PlayerState = {
  facts: [],
  stepIdx: 0,
  maxStepIdx: 0,
  attemptKey: null,
  attemptCreatedAt: null,
  queueStatus: {},
  showStartGate: false,
  hintOfferPos: null,
  hintRevealPos: null,
  toast: null,
};

function playerReducer(state: PlayerState, action: PlayerAction): PlayerState {
  switch (action.type) {
    case 'append':
      return {
        ...state,
        facts: [...state.facts, action.fact],
        // write-through is async; mirror optimistically (sent rows are never demoted in the queue)
        queueStatus: state.queueStatus[factNaturalKey(action.fact)]
          ? state.queueStatus
          : { ...state.queueStatus, [factNaturalKey(action.fact)]: 'pending' },
      };
    case 'advance':
      return { ...state, stepIdx: action.to, maxStepIdx: Math.max(state.maxStepIdx, action.to) };
    case 'hydrate':
      return {
        ...state,
        facts: action.facts,
        stepIdx: action.stepIdx,
        maxStepIdx: action.stepIdx,
        attemptKey: action.attemptKey,
        attemptCreatedAt: action.attemptCreatedAt,
        queueStatus: action.queueStatus,
        showStartGate: action.showStartGate,
      };
    case 'dismissStartGate':
      return { ...state, showStartGate: false };
    case 'setQueueStatus':
      return { ...state, queueStatus: action.status };
    case 'offerHint':
      return { ...state, hintOfferPos: action.pos };
    case 'revealHint':
      return { ...state, hintRevealPos: action.pos };
    case 'setToast':
      return { ...state, toast: action.toast };
    default:
      return state;
  }
}

export default function QuestPlayerClient({
  snapshot,
  questId,
  snapshotId,
}: {
  snapshot: QuestSnapshot;
  questId: string;
  /** Snapshot identity for attempt binding (bundle snapshot_id). */
  snapshotId: string;
}) {
  const router = useRouter();
  const online = useOnline();
  // Publish the keyboard's occluded height as --kb-inset so the report sheet
  // stays above the on-screen keyboard on iOS (Part B).
  useKeyboardInset();
  const steps: GameStep[] = snapshot.steps;
  const [state, dispatch] = useReducer(playerReducer, initialState);
  const {
    facts, stepIdx, maxStepIdx, attemptKey, attemptCreatedAt,
    queueStatus, showStartGate, hintOfferPos, hintRevealPos, toast,
  } = state;

  // SPEC (blueprint/SPEC.md §Coins): there is exactly ONE balance — the player's
  // global, cross-quest coin wallet (the fold of every CoinFact on this device).
  // It is shown identically in the top bar, the quest menu and the profile, so the
  // number never disagrees with itself. `priorLogs` holds every OTHER attempt; the
  // active attempt's LIVE facts are folded on top so the wallet moves as the player
  // earns and spends. foldLocalPlayerStats dedups the completion bonus once-per-quest
  // exactly as the server does, so replaying a quest never re-credits the bonus and
  // the wallet never "jumps" or needs a correction popup.
  const [priorLogs, setPriorLogs] = useState<AttemptLog[]>([]);

  // Guards the mount hydration to exactly one execution. Hydration is a
  // multi-step DB read, so letting StrictMode's setup→cleanup→setup run it twice
  // would race. A single run also means a stable dispatch — no `cancelled` flag.
  const didHydrateRef = useRef(false);

  const currentStep: GameStep = steps[Math.min(stepIdx, steps.length - 1)];
  const proj = projectState(facts);

  // The global coin wallet: prior attempts (all quests) + this attempt's live facts,
  // bonus-deduped once per quest. Shown in the top bar and menu (== profile).
  const walletBalance = useMemo(
    () => foldLocalPlayerStats([...priorLogs, { quest_id: questId, facts }]).balance,
    [priorLogs, questId, facts]
  );
  // Coins THIS playthrough actually added to the wallet (wallet now − wallet before
  // this attempt). On a first clear it's the full haul; on a replay it excludes the
  // already-earned completion bonus, so the finale never claims coins the wallet did
  // not receive.
  const priorWallet = useMemo(() => foldLocalPlayerStats(priorLogs).balance, [priorLogs]);
  const runEarned = walletBalance - priorWallet;

  /** Pending (unsynced) fact count — internal only: gates the debounced silent flush. */
  const pendingCount = Object.values(queueStatus).filter((s) => s === 'pending').length;

  const displaySteps = useMemo(() => steps.map(toDesignStep), [steps]);
  const currentDisplayStep = displaySteps[Math.min(stepIdx, displaySteps.length - 1)];

  // Ephemeral per-step UI state. Facts/reducer remain the sole durable source.
  // Client-only component (gated by BundleGate), so the sound preference can be
  // read lazily from localStorage at first render.
  const [ui, setUi] = useState(() => ({
    answer: '',
    wrong: false,
    menuOpen: false,
    feedbackOpen: false,
    feedbackText: '',
    rating: 0,
    /** §11: optional review text typed on the finale (sent with the rating). */
    reviewText: '',
    /** Post-finale catalog («Продолжите путешествие») shown after «что дальше». */
    showCatalog: false,
    /** «Ссылка скопирована» confirmation after a clipboard share fallback. */
    shareToast: false,
    /** §8.4: paper confirm for «Сбросить прогресс» from the menu. */
    resetConfirm: false,
    soundOn: readSoundOn(),
  }));

  // Lazily-loaded list of other published quests for the post-finale catalog
  // (null = not fetched yet). Thin metadata; see lib/catalog.nextQuestsForCatalog.
  const [published, setPublished] = useState<PublishedQuestWire[] | null>(null);

  const toggleSound = useCallback(() => {
    setUi((u) => {
      const next = !u.soundOn;
      persistSoundOn(next);
      return { ...u, soundOn: next };
    });
  }, [setUi]);

  // One shared dismiss timer: a new toast (e.g. a hint spend right after a step
  // gift) restarts the clock so an earlier toast's pending clear can never wipe
  // the current one before its own 1.9s is up.
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showToast = useCallback((amount: number, narrative?: string, soundOn?: boolean) => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    dispatch({ type: 'setToast', toast: { amount, narrative } });
    if (soundOn) (amount < 0 ? spendChime : coinChime)();
    toastTimer.current = setTimeout(() => dispatch({ type: 'setToast', toast: null }), TOAST_MS);
  }, []);

  /** Append to the reducer + write-through to the durable queue; returns the built fact. */
  const appendFact = useCallback(
    (partial: Omit<Fact, 'device_id'>): Fact => {
      const fact: Fact = { ...partial, device_id: getDeviceId() };
      dispatch({ type: 'append', fact });
      // Storage failure degrades to in-memory play (offline never blocks play),
      // never to a blocked action.
      void (async () => {
        try {
          const key = attemptKey
            ?? (await ensureActiveAttempt(questId, snapshotId)).attempt_key;
          await queueAppendFact(key, fact);
        } catch (err) {
          console.warn('fact write-through failed (in-memory only)', err);
        }
      })();
      return fact;
    },
    [attemptKey, questId, snapshotId]
  );

  // Gifts are claimed when their step is COMPLETED (physical confirm, correct
  // answer, terminal entry) — design/player/prototype.jsx semantics, never on reach.
  const claimGiftIfNeeded = useCallback(
    (pos: number) => {
      const step = steps[pos];
      const gift = step?.supporting?.gift;
      if (!gift) return;
      const alreadyClaimed = facts.some((f) => f.type === 'gift_claimed' && f.step_position === pos);
      if (alreadyClaimed) return;
      appendFact({
        type: 'gift_claimed',
        step_position: pos,
        submitted_value: null,
        local_is_correct: true,
        coins_delta: gift.coins,
        note: gift.narrative_text || null,
      });
      showToast(gift.coins, gift.narrative_text, ui.soundOn);
    },
    [steps, facts, appendFact, showToast, ui.soundOn]
  );

  const doAdvance = useCallback(() => {
    dispatch({ type: 'advance', to: Math.min(stepIdx + 1, steps.length - 1) });
  }, [stepIdx, steps.length]);

  // Back is a VIEW rewind only: the fact log is append-only and every completion
  // side effect (gift, bonus, attempt_completed) is idempotency-guarded, so
  // rereading and re-advancing through already-passed steps never double-fires.
  const doBack = useCallback(() => {
    if (stepIdx === 0) return;
    setUi((u) => ({ ...u, wrong: false, answer: '' }));
    dispatch({ type: 'advance', to: stepIdx - 1 });
  }, [stepIdx, setUi]);

  // player_back_button (feature flag, off by default): the system/browser back
  // button rewinds in-page — overlay first, then catalog→finale, then one step
  // back — and leaves the play screen only from step 0.
  const historyBackOn = useClientFeature('player_back_button');
  useHistoryBackTrap(historyBackOn, () => {
    if (ui.menuOpen) {
      setUi((u) => ({ ...u, menuOpen: false }));
      return true;
    }
    if (ui.showCatalog) {
      setUi((u) => ({ ...u, showCatalog: false }));
      return true;
    }
    if (stepIdx > 0) {
      doBack();
      return true;
    }
    return false;
  });

  const handlePhysicalConfirm = useCallback(() => {
    appendFact({
      type: 'physical_confirmed',
      step_position: stepIdx,
      submitted_value: null,
      local_is_correct: true,
      coins_delta: 0,
      note: null,
    });
    claimGiftIfNeeded(stepIdx);
    doAdvance();
  }, [stepIdx, appendFact, claimGiftIfNeeded, doAdvance]);

  const handleAnswerSubmit = useCallback(
    (value: string) => {
      if (!value.trim()) return;
      const step = currentStep;
      const correct = isAnswerCorrect(value, step.completion.acceptable);
      const fact = appendFact({
        type: 'answer_submitted',
        step_position: stepIdx,
        submitted_value: value,
        local_is_correct: correct,
        coins_delta: 0,
        note: null,
      });
      if (!correct) {
        setUi((u) => ({ ...u, wrong: true, answer: value }));
        // SPEC Wrong-Answer flow: inline error on the 1st wrong; popup only
        // from the 2nd wrong on this step while its hint is unbought.
        if (shouldOfferHint([...facts, fact], stepIdx, step)) {
          dispatch({ type: 'offerHint', pos: stepIdx });
        }
        return;
      }
      setUi((u) => ({ ...u, wrong: false, answer: '' }));
      claimGiftIfNeeded(stepIdx);
      doAdvance();
    },
    [stepIdx, currentStep, facts, appendFact, claimGiftIfNeeded, doAdvance, setUi]
  );

  const handleBuyHint = useCallback(() => {
    const pos = hintOfferPos ?? stepIdx;
    const hint = steps[pos]?.supporting?.hint;
    // Never blocked by balance — overdraft is a legal state (SPEC).
    appendFact({
      type: 'hint_purchased',
      step_position: pos,
      submitted_value: null,
      local_is_correct: true,
      coins_delta: -(hint?.cost_coins ?? 0),
      note: hint?.reveal_text || null,
    });
    dispatch({ type: 'offerHint', pos: null });
    // The purchased content (text and/or image) opens as a popup; the inline
    // hint box then keeps it for the rest of the step.
    dispatch({ type: 'revealHint', pos });
    if (hint?.cost_coins) showToast(-hint.cost_coins, 'подсказка', ui.soundOn);
  }, [hintOfferPos, stepIdx, steps, appendFact, showToast, ui.soundOn]);

  const handleFeedback = useCallback(
    (note: string) => {
      appendFact({
        type: 'feedback_reported',
        step_position: stepIdx,
        submitted_value: null,
        local_is_correct: true,
        coins_delta: 0,
        note: note || null,
      });
    },
    [stepIdx, appendFact]
  );

  const handleNavigator = useCallback(() => {
    const nav = currentStep.supporting?.navigator;
    if (!nav) return;
    appendFact({
      type: 'navigator_used',
      step_position: stepIdx,
      submitted_value: null,
      local_is_correct: true,
      coins_delta: 0,
      note: nav.label || null,
    });
    window.open(`https://www.google.com/maps/search/?api=1&query=${nav.lat},${nav.lng}`, '_blank');
  }, [stepIdx, currentStep, appendFact]);

  // Emit attempt_completed + completion bonus once on entering the terminal step.
  // Local guard for this attempt; the server enforces once-per-(player, quest) ever.
  const isTerminalStep = !!currentStep?.supporting?.terminal || currentStep?.template === 'congrats';
  const hasCompleted = facts.some((f) => f.type === 'attempt_completed');
  const handleTerminal = useCallback(() => {
    appendFact({
      type: 'attempt_completed',
      step_position: stepIdx,
      submitted_value: null,
      local_is_correct: true,
      coins_delta: 0,
      note: currentStep.rich_content.button_text || 'Квест пройден',
    });
    if (!facts.some((f) => f.type === 'completion_bonus')) {
      appendFact({
        type: 'completion_bonus',
        step_position: stepIdx,
        submitted_value: null,
        local_is_correct: true,
        coins_delta: 5,
        note: 'Бонус за прохождение',
      });
      showToast(5, 'Бонус за прохождение', ui.soundOn);
    }
    claimGiftIfNeeded(stepIdx);
  }, [stepIdx, currentStep, facts, appendFact, claimGiftIfNeeded, showToast, ui.soundOn]);
  useEffect(() => {
    if (isTerminalStep && !hasCompleted) handleTerminal();
  }, [isTerminalStep, hasCompleted, handleTerminal]);

  // «Начать заново»: re-enter the gate with the restart intent so the fresh run
  // adopts the LATEST published version — resolution + version freeze live in one
  // place (BundleGate → bundle-resolver), never split between gate and player. A
  // full reload is needed because the gate keys on the quest id, not the query.
  // Facts are never deleted (the resolver's restartAttempt only supersedes) —
  // «монеты останутся»; the completion bonus stays once-ever server-side too.
  const handleReplay = useCallback(() => {
    if (typeof window !== 'undefined') {
      window.location.assign(`/quest/${encodeURIComponent(questId)}?restart=1`);
    }
  }, [questId]);

  // Optional finale rating → a structured quest_rated fact, carried through the
  // same offline queue + idempotent sync as every other fact and surfaced to the
  // author via admin version-stats. Last-wins + idempotent: re-rating appends a
  // new fact, the same score never re-appends (mirrors latestRating).
  const recordRating = useCallback(
    (value: number, reviewText?: string) => {
      const text = reviewText?.trim().slice(0, 500) || null;
      // Re-append when the score OR the text is new (natural-key dedup absorbs
      // byte-identical repeats server-side).
      if (value <= 0 || (latestRating(facts) === value && !text)) return;
      appendFact({
        type: 'quest_rated',
        step_position: stepIdx,
        submitted_value: String(value),
        local_is_correct: true,
        coins_delta: 0,
        // §11: the optional review rides the same fact as the rating.
        note: text,
      });
    },
    [facts, stepIdx, appendFact]
  );

  // Fetch the catalog list once (guarded). Used as a prefetch on reaching the
  // finale AND as a fallback when «что дальше» is tapped — at most one request,
  // so the catalog never flashes its empty state while loading.
  const loadCatalog = useCallback(() => {
    if (published == null) {
      api.listQuests().then(setPublished).catch(() => setPublished([]));
    }
  }, [published]);

  // «что дальше» / «Пропустить»: commit the FINAL rating (once, idempotent), then
  // reveal the post-finale catalog. Committing the single final value — rather than
  // one fact per tap — avoids a re-selection ordering bug: with per-tap facts, a
  // 5→4→5 sequence would dedup the second 5 onto the first by natural key, leaving
  // 4 as the highest-seq fact and mis-recording the score. «отправим» is future
  // tense, so committing on proceed matches the copy too.
  const openCatalog = useCallback(() => {
    recordRating(ui.rating, ui.reviewText);
    setUi((u) => ({ ...u, showCatalog: true }));
    loadCatalog();
  }, [recordRating, ui.rating, loadCatalog, setUi]);

  // Share the finished quest: native share sheet when available, else copy the
  // link and confirm with the «Ссылка скопирована» toast.
  const handleShare = useCallback(() => {
    if (typeof window === 'undefined') return;
    const url = `${window.location.origin}/quest/${encodeURIComponent(questId)}`;
    const nav = window.navigator;
    if (nav && typeof nav.share === 'function') {
      nav.share({ title: snapshot.name, url }).catch(() => {});
      return;
    }
    const confirmCopy = () => {
      setUi((u) => ({ ...u, shareToast: true }));
      setTimeout(() => setUi((u) => ({ ...u, shareToast: false })), TOAST_MS);
    };
    if (nav?.clipboard?.writeText) {
      nav.clipboard.writeText(url).then(confirmCopy, confirmCopy);
    } else {
      confirmCopy();
    }
  }, [questId, snapshot.name, setUi]);

  // Prefetch the catalog when the player reaches the finale, so «что дальше»
  // reveals the next quests without a loading flash.
  useEffect(() => {
    if (isTerminalStep) loadCatalog();
  }, [isTerminalStep, loadCatalog]);

  // Re-mirror per-fact queue status into state (chips + pending counts).
  const refreshQueueStatus = useCallback(async (key: string) => {
    const rows = await getFacts(key);
    dispatch({ type: 'setQueueStatus', status: Object.fromEntries(rows.map((r) => [r.key, r.status])) });
  }, []);

  // Silent background flush: upload the queue's pending facts idempotently (lib/sync
  // owns attempt registration + single-flight), then re-mirror per-fact queue status
  // so the debounced loop ends once everything is sent. Sync is invisible to the
  // player by design — no banners, no «баланс пересчитан» popups, no correction
  // prompts. On error everything stays pending (client authoritative), retry-safe.
  const runFlush = useCallback(async () => {
    if (!online) return; // real connectivity gates every flush trigger
    try {
      const result = await flushPending({ questId, playerId: currentPlayerId(), api });
      if (result && attemptKey) await refreshQueueStatus(attemptKey);
    } catch (err) {
      console.warn('sync failed — facts stay pending (local authoritative)', err);
    }
  }, [online, questId, attemptKey, refreshQueueStatus]);

  // Mount (once): localStorage migration, then open the attempt to hydrate,
  // honoring the «Пройти заново» restart intent (?restart=1 from My Quests).
  useEffect(() => {
    if (didHydrateRef.current) return;
    didHydrateRef.current = true;
    void (async () => {
      // Restart is resolved by the gate (BundleGate) BEFORE this mounts — it
      // supersedes the old attempt, binds the fresh one to the latest snapshot,
      // and strips ?restart=1. So here we only ever RESUME the active attempt
      // (the fresh one after a restart, or the in-progress one otherwise).
      try {
        await migrateLegacyLocalStorage(questId, snapshotId, window.localStorage);
        const opened = await openAttempt(questId, snapshotId);
        dispatch({
          type: 'hydrate',
          facts: opened.facts,
          stepIdx: opened.attempt.last_step_idx,
          attemptKey: opened.attempt.attempt_key,
          attemptCreatedAt: opened.attempt.created_at,
          queueStatus: opened.queueStatus,
          showStartGate: opened.showStartGate,
        });
      } catch (err) {
        console.warn('queue hydration failed (in-memory only)', err);
      }
    })();
  }, [questId, snapshotId]);

  // Flush once hydrated; refires when connectivity returns (runFlush identity
  // changes with `online`) — "back online" semantics.
  useEffect(() => {
    if (!attemptKey) return;
    void runFlush();
  }, [attemptKey, runFlush]);

  // Load the prior slice of the cross-quest wallet (every attempt except the active
  // one). Refires whenever the active attempt changes — including «пройти заново»,
  // which supersedes the old attempt: it then folds into `priorLogs` so the wallet
  // continues from its real value instead of resetting to 0.
  useEffect(() => {
    if (!attemptKey) return;
    let alive = true;
    gatherOtherAttemptLogs(attemptKey)
      .then((logs) => { if (alive) setPriorLogs(logs); })
      .catch(() => {});
    return () => { alive = false; };
  }, [attemptKey]);

  // Flush shortly after new facts appear. Completion, the completion bonus, the
  // final gift and the finale rating all land as facts, and nothing else pushes
  // them to the server in-session — so without this the «квестов пройдено / монеты»
  // a player just earned never reach the profile until a reconnect, restart or
  // manual sync (and «Начать заново» could supersede the attempt first, stranding
  // them for good). Debounced so a burst of facts coalesces; lib/sync single-flight
  // dedupes against the mount/online flushes; pendingCount→0 after a flush ends the
  // loop. Gated on real connectivity (runFlush also checks).
  const flushDebounce = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!attemptKey || !online || pendingCount === 0) return;
    if (flushDebounce.current) clearTimeout(flushDebounce.current);
    flushDebounce.current = setTimeout(() => {
      void runFlush();
    }, 1200);
    return () => {
      if (flushDebounce.current) clearTimeout(flushDebounce.current);
    };
  }, [attemptKey, online, pendingCount, runFlush]);

  // Resume position write-through (covers every advance path incl. the advance
  // offer). Persists the FURTHEST step reached, not the viewed one — a back-
  // navigation reread must never regress where the player resumes.
  useEffect(() => {
    if (!attemptKey) return;
    setLastStepIdx(attemptKey, maxStepIdx).catch(() => {});
  }, [attemptKey, maxStepIdx]);

  const closeMenu = () => setUi((u) => ({ ...u, menuOpen: false }));
  const sendFeedback = () => {
    handleFeedback(ui.feedbackText || 'Сообщение об ошибке');
    setUi((u) => ({ ...u, feedbackOpen: false, feedbackText: '' }));
  };

  if (showStartGate) {
    // §8.2: the gate lives INSIDE the paper frame — no site chrome around it.
    return (
      <PlayerFrame tw={{ art: 'paper', layout: 'image', anims: true }} screenLabel="player-start-gate">
        <StartGate
          title={snapshot.name}
          createdAt={attemptCreatedAt}
          pos={Math.min(stepIdx + 1, displaySteps.length)}
          total={displaySteps.length}
          coins={runEarned}
          onContinue={() => dispatch({ type: 'dismissStartGate' })}
          onRestart={handleReplay}
        />
      </PlayerFrame>
    );
  }

  const pos = currentStep.position ?? stepIdx;
  // City/duration are the author's real values frozen into the snapshot at publish
  // (undefined for snapshots published before the field existed — the player then
  // simply omits them rather than showing a hardcoded place). completionBonus is the
  // canonical +5 (SPEC), not quest-specific data.
  const questMeta = {
    title: snapshot.name,
    city: snapshot.city,
    duration: snapshot.duration,
    completionBonus: 5,
  };
  const hintStep = hintOfferPos != null ? steps[hintOfferPos] : null;

  // The terminal step renders FinalScreen (via StepView's congrats branch): the
  // rating is local + optional, committed as a quest_rated fact only on «что
  // дальше»/«Пропустить» (openCatalog). A prior rating rehydrates from the log.
  const stepBody = (
    <StepView
      step={currentDisplayStep}
      quest={questMeta}
      copy={COPY}
      st={{
        hintRevealed: proj.revealedHints.includes(pos),
        wrong: ui.wrong,
        answer: ui.answer,
        rating: ui.rating || latestRating(facts),
        reviewText: ui.reviewText,
        coinsEarned: runEarned,
        time: formatElapsed(attemptCreatedAt),
      }}
      on={{
        next: () => { setUi((u) => ({ ...u, wrong: false, answer: '' })); doAdvance(); },
        confirm: handlePhysicalConfirm,
        submit: handleAnswerSubmit,
        answer: (v: string) => setUi((u) => ({ ...u, answer: v, wrong: false })),
        buyHint: handleBuyHint,
        navigator: handleNavigator,
        play: () => { /* inline video playback lands with real media refs */ },
        // Tapping a star only updates local state + shows the inline thanks; the
        // single quest_rated fact is committed with the final value on «что дальше».
        rate: (n: number) => setUi((u) => ({ ...u, rating: n })),
        reviewText: (v: string) => setUi((u) => ({ ...u, reviewText: v })),
        onward: openCatalog,
        // Chromeless finale: the floating back button lets the player reread
        // the last steps (view-only rewind; completion facts stay guarded).
        back: stepIdx > 0 ? doBack : undefined,
        // «пройти заново» restarts from step 0. The tapped rating is intentionally
        // NOT committed here: a quest_rated fact is delivered only via the forward
        // «что дальше» path (openCatalog), because the queue flushes only the
        // ACTIVE attempt — committing on replay would strand the fact on the
        // just-superseded attempt, never reaching the author. Restart is a fresh
        // start; «отправим автору» belongs to the forward action.
        replay: handleReplay,
      }}
    />
  );

  // Post-finale catalog of other published quests (thin metadata → cover + title
  // + CTA). Picking one opens its player; share/home are the soft exits.
  const body = ui.showCatalog ? (
    <CatalogScreen
      quests={nextQuestsForCatalog(published || [], questId)}
      copy={COPY}
      on={{
        pick: (id) => router.push(`/quest/${encodeURIComponent(id)}`),
        share: handleShare,
        home: () => router.push('/'),
        back: () => setUi((u) => ({ ...u, showCatalog: false })),
      }}
    />
  ) : stepBody;

  // The final and catalog screens are chromeless (no top bar) — matching the design.
  const showTop = !isTerminalStep && !ui.showCatalog;

  return (
    <PlayerFrame
      tw={{ art: 'paper', layout: 'image', anims: true }}
      screenLabel={ui.showCatalog ? 'player-catalog' : `player-step-${pos}`}
    >
      {showTop && (
        <>
          <TopBar
            pos={pos + 1}
            total={displaySteps.length}
            coins={walletBalance}
            onMenu={() => setUi((u) => ({ ...u, menuOpen: true }))}
            onBack={stepIdx > 0 ? doBack : undefined}
          />
          {/* §8.3: 2px ink progress — completed/total, visible outside the menu */}
          <div className="p-progress" aria-hidden>
            <span style={{ width: `${(proj.completedSteps.length / Math.max(displaySteps.length, 1)) * 100}%` }} />
          </div>
        </>
      )}
      <div className="p-scroll">{body}</div>
      {toast && <CoinToast amount={toast.amount} narrative={toast.narrative} copy={COPY} />}
      {ui.shareToast && (
        <div className="p-toast" role="status"><PCheck size={18} /><span>{COPY.shareCopied || 'Ссылка скопирована'}</span></div>
      )}

      {hintStep?.supporting?.hint && (
        <HintPopup
          step={{ hint: { cost: hintStep.supporting.hint.cost_coins } }}
          copy={COPY}
          on={{ buy: handleBuyHint, dismiss: () => dispatch({ type: 'offerHint', pos: null }) }}
        />
      )}
      {hintRevealPos != null && steps[hintRevealPos]?.supporting?.hint && (
        <HintRevealPopup
          hint={{
            text: steps[hintRevealPos].supporting?.hint?.reveal_text,
            image: steps[hintRevealPos].media?.hint,
          }}
          copy={COPY}
          on={{ dismiss: () => dispatch({ type: 'revealHint', pos: null }) }}
        />
      )}
      {ui.menuOpen && (
        <MenuOverlay
          quest={questMeta}
          copy={COPY}
          st={{ pos: stepIdx + 1, total: displaySteps.length, coins: walletBalance, sound: ui.soundOn }}
          on={{
            close: closeMenu,
            feedback: () => setUi((u) => ({ ...u, menuOpen: false, feedbackOpen: true })),
            exit: () => router.push('/my-quests'),
            // §8.4: reset confirms in a paper popup — never fires directly.
            reset: () => setUi((u) => ({ ...u, menuOpen: false, resetConfirm: true })),
            sound: toggleSound,
          }}
        />
      )}
      {ui.resetConfirm && (
        <div className="p-reset__ovl" onClick={() => setUi((u) => ({ ...u, resetConfirm: false }))}>
          <div className="p-reset" role="alertdialog" onClick={(e) => e.stopPropagation()}>
            <p className="p-reset__title">Начать заново?</p>
            <p className="p-reset__text">Прогресс попытки исчезнет — вернётесь к шагу 1. Заработанные монеты останутся при вас.</p>
            <button
              className="sg2__btn"
              style={{ height: 50, fontSize: 14 }}
              type="button"
              onClick={() => { setUi((u) => ({ ...u, resetConfirm: false })); handleReplay(); }}
            >
              начать заново
            </button>
            <button className="sg2__btn sg2__btn--outline" type="button" onClick={() => setUi((u) => ({ ...u, resetConfirm: false }))}>отмена</button>
          </div>
        </div>
      )}
      {ui.feedbackOpen && (
        <FeedbackSheet
          quest={questMeta}
          copy={COPY}
          st={{ pos: stepIdx + 1, stepName: currentDisplayStep.title, text: ui.feedbackText }}
          on={{
            dismiss: () => setUi((u) => ({ ...u, feedbackOpen: false })),
            text: (e: React.ChangeEvent<HTMLTextAreaElement>) => setUi((u) => ({ ...u, feedbackText: e.target.value })),
            send: sendFeedback,
          }}
        />
      )}
    </PlayerFrame>
  );
}
