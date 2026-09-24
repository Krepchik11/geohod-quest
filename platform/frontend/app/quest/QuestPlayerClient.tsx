'use client';

import React, { useReducer, useEffect, useCallback, useMemo, useState, useRef } from 'react';
import { useRouter } from 'next/navigation';
import type { Fact, GameStep, OncePerQuestType, QuestSnapshot } from '../../lib/shared-model';
import { projectState, latestRating, solvedAnswerAt, wrongPopupAt } from '../../lib/shared-model';

import {
  COMPLETION_BONUS,
  hydratedPlayState,
  initialPlayState,
  isTerminalStep,
  transition,
  type PlayCtx,
  type PlayEvent,
  type PlayState,
} from '../../lib/play-loop';
import { queueFactSink } from '../../lib/fact-sink';
import {
  earnedQuestBonuses,
  foldLocalPlayerStats,
  gatherOtherAttemptLogs,
  type AttemptLog,
} from '../../lib/player-stats';
import { elapsedLabel, toDesignStep } from '../../lib/design-step';
import { skipCost as snapshotSkipCost, stepAt, theme as snapshotTheme } from '../../lib/snapshot';
import { api } from '../../lib/api';
import {
  factNaturalKey,
  ensureActiveAttempt,
  getFacts,
  setLastStepIdx,
  openAttempt,
  migrateLegacyLocalStorage,
} from '../../lib/queue';
import { flushPending } from '../../lib/sync';
import { currentUserId, getDeviceId } from '../../lib/identity';
import { mapsSearchUrl } from '../../lib/maps';
import { useClientFeature, useUniversalAnswer } from '../../lib/client-features';
import { StartGate } from './StartGate';
import { coinChime, spendChime } from './sound';
import { useOnline } from './useOnline';
import { shareQuest } from '../../lib/share';
// Aliased twice over: this file already has a `toast` (coin-toast UI state)
// AND a `showToast` (the coin-toast callback).
import { toast as notify } from '../components/Toaster';
import { useStepHistory } from './useStepHistory';
import { useKeyboardInset } from './useKeyboardInset';
import {
  PlayerFrame, StepView, TopBar, CoinToast,
  HintPopup, HintRevealPopup, MenuOverlay, FeedbackSheet,
} from '../player/PlayerComponents';

/** RU copy, classic tone — shared with the constructor preview/test player. */
import { PLAYER_COPY as COPY } from '../../lib/player-copy';

const SOUND_PREF_KEY = 'geohod-player-sound:v1';
const TOAST_MS = 1900;
/** Where the finale lets the player out: the store grid, same target as the
 *  «Магазин» tab. It already lists every other quest with search, filters and
 *  reviews, so the player has no second, thinner copy of that list to sit
 *  through first (issue #112). */
const STORE_HREF = '/#shop';

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

interface PlayerState {
  /** The game-rule state — owned by the engine (lib/play-loop). `stepIdx` is an
   *  ARRAY INDEX, the single step identity in this component: every fact is
   *  written with `step_position: stepIdx`, and the backend reads it back as an
   *  index (`steps.get(i)` in admin stats / moderation). The snapshot's own
   *  `position` field is descriptive metadata a hand-authored or legacy snapshot
   *  may number any way it likes; deriving display state from it would silently
   *  decouple the rendered step from its own facts. `maxStepIdx` is the resume
   *  anchor — persisted instead of stepIdx so a back-navigation reread never
   *  regresses where the player resumes. */
  play: PlayState;
  /* Local attempt identity from the IndexedDB queue (server id lives there too). */
  attemptKey: string | null;
  attemptCreatedAt: string | null;
  /** When the attempt finished. Recorded ONCE — on hydrate it comes back from
   *  the queue row of the completion fact — because «в пути» is the duration of
   *  the attempt, not the age of it: reading the clock at render time made the
   *  finished quest's own stat grow on every reopen (issue #111). */
  attemptCompletedAt: string | null;
  /* Per-fact queue status mirror (natural key → status). Internal only: it drives
     the debounced silent flush (pending → 0 ends the loop); never rendered. */
  queueStatus: Record<string, 'pending' | 'sent'>;
  /* Start gate (SPEC): shown when an in-progress attempt was hydrated. */
  showStartGate: boolean;
  /** Designed coin toast: positive = gift/bonus, negative = spend. */
  toast: { amount: number; narrative?: string } | null;
  /** The queue has been read (or failed): true once the facts and the prior
   *  attempts are known. Rules that fire by themselves wait for it — an engine
   *  run against an unread log awards what the log would have withheld. */
  hydrated: boolean;
}

type PlayerAction =
  | { type: 'apply'; play: PlayState; appended: Fact[]; completedAt: string | null }
  | {
      type: 'hydrate';
      facts: Fact[];
      stepIdx: number;
      attemptKey: string;
      attemptCreatedAt: string;
      attemptCompletedAt: string | null;
      queueStatus: Record<string, 'pending' | 'sent'>;
      showStartGate: boolean;
    }
  | { type: 'hydrateFailed' }
  | { type: 'dismissStartGate' }
  | { type: 'setQueueStatus'; status: Record<string, 'pending' | 'sent'> }
  | { type: 'setToast'; toast: PlayerState['toast'] };

const initialState: PlayerState = {
  play: initialPlayState(),
  attemptKey: null,
  attemptCreatedAt: null,
  attemptCompletedAt: null,
  queueStatus: {},
  showStartGate: false,
  toast: null,
  hydrated: false,
};

function playerReducer(state: PlayerState, action: PlayerAction): PlayerState {
  switch (action.type) {
    case 'apply': {
      // write-through is async; mirror optimistically (sent rows are never demoted in the queue)
      let queueStatus = state.queueStatus;
      for (const fact of action.appended) {
        const key = factNaturalKey(fact);
        if (!queueStatus[key]) queueStatus = { ...queueStatus, [key]: 'pending' };
      }
      return {
        ...state,
        play: action.play,
        queueStatus,
        attemptCompletedAt: state.attemptCompletedAt ?? action.completedAt,
      };
    }
    case 'hydrate':
      return {
        ...state,
        play: hydratedPlayState(action.facts, action.stepIdx),
        attemptKey: action.attemptKey,
        attemptCreatedAt: action.attemptCreatedAt,
        attemptCompletedAt: action.attemptCompletedAt,
        queueStatus: action.queueStatus,
        showStartGate: action.showStartGate,
        hydrated: true,
      };
    case 'hydrateFailed':
      return { ...state, hydrated: true };
    case 'dismissStartGate':
      return { ...state, showStartGate: false };
    case 'setQueueStatus':
      return { ...state, queueStatus: action.status };
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
  paidBonuses,
}: {
  snapshot: QuestSnapshot;
  questId: string;
  /** Snapshot identity for attempt binding (bundle snapshot_id). */
  snapshotId: string;
  /** Once-ever bonuses the SERVER says this quest already paid — read by the
   *  gate before this mounts, because a device that never played the quest has
   *  nothing in its own queue to read (issue #117). Empty when the answer is
   *  unknown (offline, or the request failed): unknown withholds nothing. */
  paidBonuses: readonly OncePerQuestType[];
}) {
  const router = useRouter();
  const online = useOnline();
  // Publish the keyboard's occluded height as --kb-inset so the report sheet
  // stays above the on-screen keyboard on iOS (Part B).
  useKeyboardInset();
  const steps: GameStep[] = snapshot.steps;
  // Цвета берутся из ЗАМОРОЖЕННОГО снапшота, поэтому начатое прохождение не
  // перекрашивается новой публикацией — как и всё остальное его содержимое.
  const theme = useMemo(() => snapshotTheme(snapshot), [snapshot]);
  // Цена «Пропустить задание» — тоже из замороженного снапшота (старый без поля
  // даёт дефолт).
  const skipCost = useMemo(() => snapshotSkipCost(snapshot), [snapshot]);
  const [state, dispatch] = useReducer(playerReducer, initialState);
  const { play, attemptKey, attemptCreatedAt, attemptCompletedAt, queueStatus, showStartGate, toast, hydrated } = state;
  const { facts, stepIdx, maxStepIdx, hintOfferPos, hintRevealPos } = play;

  // Coins: there is exactly ONE balance — the player's
  // global, cross-quest coin wallet (the fold of every CoinFact on this device).
  // It is shown identically in the top bar, the quest menu and the profile, so the
  // number never disagrees with itself. `priorLogs` holds every OTHER attempt; the
  // active attempt's LIVE facts are folded on top so the wallet moves as the player
  // earns and spends. foldLocalPlayerStats dedups every once-ever bonus
  // (completion, rating, comment) once-per-quest exactly as the server does, so
  // replaying a quest never re-credits them and the wallet never "jumps" or
  // needs a correction popup. «Начать заново» reloads the page, so reading them
  // once on mount is enough.
  const [priorLogs, setPriorLogs] = useState<AttemptLog[]>([]);

  // Guards the mount hydration to exactly one execution. Hydration is a
  // multi-step DB read, so letting StrictMode's setup→cleanup→setup run it twice
  // would race. A single run also means a stable dispatch — no `cancelled` flag.
  const didHydrateRef = useRef(false);

  const currentStep: GameStep = stepAt(snapshot, stepIdx);
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
  // What this quest already paid — this device's logs plus what the server knows
  // of the others. A bonus named here is never minted again, so the wallet above
  // never has a second copy to collapse.
  const earnedBonuses = useMemo(
    () => earnedQuestBonuses(priorLogs, questId, paidBonuses),
    [priorLogs, questId, paidBonuses]
  );
  const runEarned = walletBalance - priorWallet;

  /** Pending (unsynced) fact count — internal only: gates the debounced silent flush. */
  const pendingCount = Object.values(queueStatus).filter((s) => s === 'pending').length;

  const currentDisplayStep = useMemo(() => toDesignStep(currentStep), [currentStep]);

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
    /** §8.4: paper confirm for «Сбросить прогресс» from the menu. */
    resetConfirm: false,
    soundOn: readSoundOn(),
  }));

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

  // Ordered write-through to the durable queue (lib/fact-sink): appends reach
  // storage in append order; a failure degrades that fact to in-memory play.
  // ensureActiveAttempt returns the same active attempt openAttempt hydrated,
  // so the sink needs no attemptKey mirror.
  const sink = useMemo(
    () => queueFactSink(async () => (await ensureActiveAttempt(questId, snapshotId)).attempt_key),
    [questId, snapshotId]
  );

  // player_back_button (feature flag, off by default): every advance pushes a
  // real history entry, so the system/browser back button traverses steps
  // natively — consecutive presses rewind all the way to step 0, then one
  // press leaves. An open overlay (menu, post-finale catalog) eats the press.
  // See useStepHistory for why entries-mirror-steps is the only design the
  // browsers' anti-trapping rules allow.
  const historyBackOn = useClientFeature('player_back_button');
  // Platform-wide universal answer (null while loading / flag off / unset) —
  // merged into every answer check next to the snapshot's quest-wide one.
  const globalUniversalAnswer = useUniversalAnswer();
  // Rule inputs for the engine. Built per event (not per render): getDeviceId
  // touches localStorage, which must stay out of the render path.
  const buildCtx = useCallback(
    (): PlayCtx => ({
      steps,
      deviceId: getDeviceId(),
      // The quest-wide universal answer frozen in the snapshot and the
      // platform-wide one (admin flag+value).
      universalAnswers: [snapshot.universal_answer, globalUniversalAnswer],
      earnedBonuses,
      skipCost,
    }),
    [steps, snapshot.universal_answer, globalUniversalAnswer, earnedBonuses, skipCost]
  );

  const stepHistory = useStepHistory(historyBackOn, {
    stepIdx,
    // View follows the traversed entry, clamped: entries can outlive the
    // attempt that made them (replay reloads the page but keeps history), and
    // maxStepIdx caps a stale redo at the furthest step actually reached.
    // Applied as a bare transition — a traversal must never push history.
    onGoToStep: (idx) => {
      const to = Math.max(0, Math.min(idx, maxStepIdx, steps.length - 1));
      setUi((u) => ({ ...u, wrong: false, answer: '' }));
      const result = transition(play, { type: 'advance_to', to }, buildCtx());
      dispatch({ type: 'apply', play: result.state, appended: [], completedAt: null });
    },
    isOverlayOpen: () => ui.menuOpen,
    onCloseOverlay: () => setUi((u) => ({ ...u, menuOpen: false })),
  });

  /** The ONE rule path: engine transition → reducer + sink + designed effects. */
  const runEvent = useCallback(
    (event: PlayEvent) => {
      const result = transition(play, event, buildCtx());
      // The completion instant is stamped exactly once, where completion
      // happens; every later read comes off the queue row instead (issue #111).
      const completedAt = result.effects.appended.some((f) => f.type === 'attempt_completed')
        ? new Date().toISOString()
        : null;
      dispatch({ type: 'apply', play: result.state, appended: result.effects.appended, completedAt });
      result.effects.appended.forEach((f) => sink.append(f));
      if (result.effects.toast) {
        showToast(result.effects.toast.amount, result.effects.toast.narrative, ui.soundOn);
      }
      if (result.effects.advanced) {
        stepHistory.advance(play.stepIdx, result.state.stepIdx);
      }
      if (result.effects.openMaps) {
        window.open(mapsSearchUrl(result.effects.openMaps.lat, result.effects.openMaps.lng), '_blank');
      }
      return result;
    },
    [play, buildCtx, sink, showToast, ui.soundOn, stepHistory]
  );

  const doAdvance = useCallback(() => {
    runEvent({ type: 'advance_to', to: stepIdx + 1 });
  }, [runEvent, stepIdx]);

  // Back is a VIEW rewind only: the fact log is append-only and every completion
  // side effect (gift, bonus, attempt_completed) is idempotency-guarded, so
  // rereading and re-advancing through already-passed steps never double-fires.
  // The on-screen back button moves the view directly (no history traversal);
  // the entry it diverges from is healed by the next advance's replaceState.
  const doBack = useCallback(() => {
    if (stepIdx === 0) return;
    setUi((u) => ({ ...u, wrong: false, answer: '' }));
    runEvent({ type: 'back' });
  }, [stepIdx, setUi, runEvent]);

  const handlePhysicalConfirm = useCallback(() => {
    runEvent({ type: 'physical_confirm' });
  }, [runEvent]);

  const handleAnswerSubmit = useCallback(
    (value: string) => {
      const result = runEvent({ type: 'answer', value });
      // SPEC Wrong-Answer flow: the inline error flash derives from the verdict
      // the engine recorded; the popup state (every wrong) lives in PlayState.
      const answered = result.effects.answered;
      if (!answered) {
        // A solved step's arrow only moves on (no verdict): clear the field as
        // `next` does.
        if (result.effects.advanced) setUi((u) => ({ ...u, wrong: false, answer: '' }));
        return;
      }
      setUi((u) =>
        answered.correct
          ? { ...u, wrong: false, answer: '' }
          : { ...u, wrong: true, answer: value }
      );
    },
    [runEvent, setUi]
  );

  const handleBuyHint = useCallback(() => {
    runEvent({ type: 'buy_hint' });
  }, [runEvent]);

  // «Пропустить задание» из попапа неверного ответа: переход на следующий шаг,
  // поэтому поле ответа очищается, как при `next`.
  const handleSkip = useCallback(() => {
    setUi((u) => ({ ...u, wrong: false, answer: '' }));
    runEvent({ type: 'skip_task' });
  }, [runEvent, setUi]);

  const handleFeedback = useCallback(
    (note: string) => {
      runEvent({ type: 'feedback', note });
    },
    [runEvent]
  );

  const handleNavigator = useCallback(() => {
    runEvent({ type: 'navigator' });
  }, [runEvent]);

  // The engine completes the attempt when an advance lands on the finale; this
  // effect covers ONLY hydrate/start ON the finale (no advance happens then).
  // The engine's own log guard makes a repeat enter_terminal a no-op.
  const onFinale = isTerminalStep(currentStep);
  useEffect(() => {
    if (hydrated && onFinale) runEvent({ type: 'enter_terminal' });
  }, [hydrated, onFinale, runEvent]);

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
    (value: number, reviewText?: string | null) => runEvent({ type: 'rate', value, text: reviewText ?? null }),
    [runEvent]
  );

  // The score the finale shows: what the player just tapped, else what the log
  // already carries (a reopened finale keeps its rating).
  const committedRating = latestRating(facts);
  const shownRating = ui.rating || committedRating;

  // §11 pays for the stars and pays again for the review. Both rewards land the
  // moment the player earns them — the first star tap commits the score, sending
  // the review commits the text — so the coin animation and the «монет собрано»
  // counter move together with the action that caused them (issue #113).
  // The first tap is the ONLY per-tap commit: a 5→4→5 re-selection would dedup
  // the second 5 onto the first by natural key and leave 4 as the highest-seq
  // fact, so every later change rides the single commit on the way out.
  const handleRate = useCallback(
    (value: number) => {
      setUi((u) => ({ ...u, rating: value }));
      if (committedRating === 0) recordRating(value, null);
    },
    [committedRating, recordRating, setUi]
  );

  // Leaving the finale must not cut the coin animation short, so the store waits
  // out the toast when the exit itself earned coins.
  const leaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (leaveTimer.current) clearTimeout(leaveTimer.current); }, []);

  // «ОТПРАВИТЬ ОЦЕНКУ» / «Пропустить оценку»: commit whatever the card holds
  // (idempotent — an unchanged score appends nothing) and leave for the store.
  const finish = useCallback(() => {
    const result = recordRating(shownRating, ui.reviewText);
    const go = () => router.push(STORE_HREF);
    if (!result.effects.toast) {
      go();
      return;
    }
    if (leaveTimer.current) clearTimeout(leaveTimer.current);
    leaveTimer.current = setTimeout(go, TOAST_MS);
  }, [recordRating, shownRating, ui.reviewText, router]);

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
      const result = await flushPending({ questId, userId: currentUserId(), api });
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
        // Read before the hydrate below, so no rule ever runs without it (#114).
        setPriorLogs(await gatherOtherAttemptLogs(opened.attempt.attempt_key).catch(() => []));
        dispatch({
          type: 'hydrate',
          facts: opened.facts,
          stepIdx: opened.attempt.last_step_idx,
          attemptKey: opened.attempt.attempt_key,
          attemptCreatedAt: opened.attempt.created_at,
          attemptCompletedAt: opened.completedAt,
          queueStatus: opened.queueStatus,
          showStartGate: opened.showStartGate,
        });
      } catch (err) {
        console.warn('queue hydration failed (in-memory only)', err);
        dispatch({ type: 'hydrateFailed' });
      }
    })();
  }, [questId, snapshotId]);

  // Flush once hydrated; refires when connectivity returns (runFlush identity
  // changes with `online`) — "back online" semantics.
  useEffect(() => {
    if (!attemptKey) return;
    void runFlush();
  }, [attemptKey, runFlush]);

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
      <PlayerFrame tw={{ anims: true }} screenLabel="player-start-gate" theme={theme}>
        <StartGate
          title={snapshot.name}
          createdAt={attemptCreatedAt}
          pos={Math.min(stepIdx + 1, steps.length)}
          total={steps.length}
          coins={runEarned}
          onContinue={() => dispatch({ type: 'dismissStartGate' })}
          onRestart={handleReplay}
        />
      </PlayerFrame>
    );
  }

  // City/duration are the author's real values frozen into the snapshot at publish
  // (undefined for snapshots published before the field existed — the player then
  // simply omits them rather than showing a hardcoded place). completionBonus is the
  // canonical bonus (SPEC), not quest-specific data.
  const questMeta = {
    title: snapshot.name,
    city: snapshot.city,
    duration: snapshot.duration,
    completionBonus: COMPLETION_BONUS,
  };
  // The wrong-answer popup: open on hintOfferPos; what it holds is the ONE rule
  // in shared-model (wrongPopupAt), not a condition restated here.
  const popupStep = hintOfferPos != null ? steps[hintOfferPos] : null;
  const wrongPopup = popupStep && hintOfferPos != null ? wrongPopupAt(facts, hintOfferPos, popupStep) : null;

  // The terminal step renders FinalScreen (via StepView's congrats branch): the
  // rating is local + optional, committed as a quest_rated fact only on «что
  // дальше»/«Пропустить» (openCatalog). A prior rating rehydrates from the log.
  const stepBody = (
    <StepView
      step={currentDisplayStep}
      quest={questMeta}
      copy={COPY}
      st={{
        hintRevealed: proj.revealedHints.includes(stepIdx),
        wrong: ui.wrong,
        answer: ui.answer,
        solved: solvedAnswerAt(facts, stepIdx),
        rating: shownRating,
        reviewText: ui.reviewText,
        coinsEarned: runEarned,
        time: elapsedLabel(attemptCreatedAt, attemptCompletedAt),
      }}
      on={{
        next: () => { setUi((u) => ({ ...u, wrong: false, answer: '' })); doAdvance(); },
        confirm: handlePhysicalConfirm,
        submit: handleAnswerSubmit,
        answer: (v: string) => setUi((u) => ({ ...u, answer: v, wrong: false })),
        buyHint: handleBuyHint,
        navigator: handleNavigator,
        play: () => { /* inline video playback lands with real media refs */ },
        rate: handleRate,
        reviewText: (v: string) => setUi((u) => ({ ...u, reviewText: v })),
        onward: finish,
        // Chromeless finale: the floating back button lets the player reread
        // the last steps (view-only rewind; completion facts stay guarded).
        // No replay affordance here (§11) — restarting lives in the menu.
        back: stepIdx > 0 ? doBack : undefined,
        // §share: NOT behind the quest_share flag. Flags are fetched from
        // /api/features and read false offline — and the finale is where the
        // player most often is. Called straight from the click so the OS
        // sheet still has its transient user activation.
        share: () => {
          void shareQuest({ questId, name: snapshot.name, city: snapshot.city }).then((r) => {
            if (r === 'copied') notify('Ссылка на квест скопирована');
            if (r === 'failed') notify('Не удалось поделиться — проверьте разрешения браузера');
          });
        },
      }}
    />
  );

  // The final screen is chromeless (no top bar) — matching the design.
  const showTop = !onFinale;

  return (
    <PlayerFrame tw={{ anims: true }} screenLabel={`player-step-${stepIdx}`} theme={theme}>
      {showTop && (
        <>
          <TopBar
            pos={stepIdx + 1}
            total={steps.length}
            coins={walletBalance}
            onMenu={() => setUi((u) => ({ ...u, menuOpen: true }))}
            onBack={stepIdx > 0 ? doBack : undefined}
          />
          {/* §8.3: 2px ink progress — completed/total, visible outside the menu */}
          <div className="p-progress" aria-hidden>
            <span style={{ width: `${(proj.completedSteps.length / Math.max(steps.length, 1)) * 100}%` }} />
          </div>
        </>
      )}
      <div className="p-scroll">{stepBody}</div>
      {toast && <CoinToast amount={toast.amount} narrative={toast.narrative} copy={COPY} />}

      {popupStep && wrongPopup && (
        <HintPopup
          popup={wrongPopup}
          hint={toDesignStep(popupStep).hint}
          skipCost={skipCost}
          copy={COPY}
          on={{ buy: handleBuyHint, skip: handleSkip, dismiss: () => runEvent({ type: 'dismiss_hint_offer' }) }}
        />
      )}
      {hintRevealPos != null && steps[hintRevealPos]?.supporting?.hint && (
        <HintRevealPopup
          hint={{
            text: steps[hintRevealPos].supporting?.hint?.reveal_text,
            image: steps[hintRevealPos].media?.hint,
          }}
          copy={COPY}
          on={{ dismiss: () => runEvent({ type: 'dismiss_hint_reveal' }) }}
        />
      )}
      {ui.menuOpen && (
        <MenuOverlay
          quest={questMeta}
          copy={COPY}
          st={{ pos: stepIdx + 1, total: steps.length, coins: walletBalance, sound: ui.soundOn }}
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
