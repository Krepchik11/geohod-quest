'use client';

import React, { useReducer, useEffect, useCallback, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { Fact, GameStep, QuestSnapshot, SyncCorrections } from '../../lib/shared-model';
import {
  isAnswerCorrect,
  projectBalance,
  projectState,
  shouldOfferHint,
  deriveSyncCorrections,
  latestRating,
} from '../../lib/shared-model';
import { toDesignStep } from '../../lib/design-step';
import { api, type PublishedQuestWire } from '../../lib/api';
import { nextQuestsForCatalog } from '../../lib/catalog';
import {
  factNaturalKey,
  ensureActiveAttempt,
  getFacts,
  setLastStepIdx,
  restartAttempt,
  migrateLegacyLocalStorage,
  appendFact as queueAppendFact,
} from '../../lib/queue';
import { flushPending } from '../../lib/sync';
import { currentPlayerId, getDeviceId } from '../../lib/identity';
import { StartGate } from './StartGate';
import { coinChime } from './sound';
import { useOnline } from './useOnline';
import {
  PlayerFrame, StepView, TopBar, SyncBanner, CoinToast, PCheck,
  HintPopup, MenuOverlay, FeedbackSheet, CatalogScreen,
  SyncSheet, BalanceCorrectionPopup, AdvanceOfferPopup,
} from '../player/PlayerComponents';

/** RU copy, classic tone — shared with the constructor preview/test player. */
import { PLAYER_COPY as COPY } from '../../lib/player-copy';

const SOUND_PREF_KEY = 'geohod-player-sound:v1';
const TOAST_MS = 1900;
const SYNCED_BANNER_MS = 2400;

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
  /* Local attempt identity from the IndexedDB queue (server id lives there too). */
  attemptKey: string | null;
  attemptCreatedAt: string | null;
  isSyncing: boolean;
  /** Briefly true after a successful flush — drives the «синхронизировано» banner. */
  justSynced: boolean;
  /* The two SPEC corrections, derived client-side after sync (popups). */
  corrections: SyncCorrections | null;
  /* Per-fact queue status mirror (natural key → status) — chips/pending counts. */
  queueStatus: Record<string, 'pending' | 'sent'>;
  /* Start gate (SPEC): shown when an in-progress attempt was hydrated. */
  showStartGate: boolean;
  /** Step whose hint popup is open (SPEC: from the 2nd wrong answer only). */
  hintOfferPos: number | null;
  /** Designed coin toast (gift / completion bonus). */
  toast: { amount: number; narrative?: string } | null;
}

type PlayerAction =
  | { type: 'append'; fact: Fact }
  | { type: 'advance'; to: number }
  | { type: 'reset'; attemptKey: string; attemptCreatedAt: string }
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
  | { type: 'setSyncing'; v: boolean }
  | { type: 'setJustSynced'; v: boolean }
  | { type: 'setCorrections'; corrections: SyncCorrections | null }
  | { type: 'dismissBalanceNotice' }
  | { type: 'resolveAdvanceOffer' }
  | { type: 'setQueueStatus'; status: Record<string, 'pending' | 'sent'> }
  | { type: 'offerHint'; pos: number | null }
  | { type: 'setToast'; toast: PlayerState['toast'] };

const initialState: PlayerState = {
  facts: [],
  stepIdx: 0,
  attemptKey: null,
  attemptCreatedAt: null,
  isSyncing: false,
  justSynced: false,
  corrections: null,
  queueStatus: {},
  showStartGate: false,
  hintOfferPos: null,
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
      return { ...state, stepIdx: action.to };
    case 'reset':
      return {
        ...initialState,
        attemptKey: action.attemptKey,
        attemptCreatedAt: action.attemptCreatedAt,
      };
    case 'hydrate':
      return {
        ...state,
        facts: action.facts,
        stepIdx: action.stepIdx,
        attemptKey: action.attemptKey,
        attemptCreatedAt: action.attemptCreatedAt,
        queueStatus: action.queueStatus,
        showStartGate: action.showStartGate,
      };
    case 'dismissStartGate':
      return { ...state, showStartGate: false };
    case 'setSyncing':
      return { ...state, isSyncing: action.v };
    case 'setJustSynced':
      return { ...state, justSynced: action.v };
    case 'setCorrections':
      return { ...state, corrections: action.corrections };
    case 'dismissBalanceNotice':
      return state.corrections
        ? { ...state, corrections: { ...state.corrections, balanceNotice: undefined } }
        : state;
    case 'resolveAdvanceOffer':
      return state.corrections
        ? { ...state, corrections: { ...state.corrections, advanceOffer: undefined } }
        : state;
    case 'setQueueStatus':
      return { ...state, queueStatus: action.status };
    case 'offerHint':
      return { ...state, hintOfferPos: action.pos };
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
  const steps: GameStep[] = snapshot.steps;
  const [state, dispatch] = useReducer(playerReducer, initialState);
  const {
    facts, stepIdx, attemptKey, attemptCreatedAt, isSyncing, justSynced,
    corrections, queueStatus, showStartGate, hintOfferPos, toast,
  } = state;

  const currentStep: GameStep = steps[Math.min(stepIdx, steps.length - 1)];
  const bal = projectBalance(facts);
  const proj = projectState(facts);
  /** Facts the server has not acknowledged yet — banner badge + menu + sheet chips. */
  const pendingCount = Object.values(queueStatus).filter((s) => s === 'pending').length;

  const displaySteps = useMemo(() => steps.map(toDesignStep), [steps]);
  const currentDisplayStep = displaySteps[Math.min(stepIdx, displaySteps.length - 1)];

  // Ephemeral per-step UI state. Facts/reducer remain the sole durable source.
  // Client-only component (gated by BundleGate), so the sound preference can be
  // read lazily from localStorage at first render.
  const [ui, setUi] = useState(() => ({
    answer: '',
    wrong: false,
    note: '',
    menuOpen: false,
    feedbackOpen: false,
    syncSheetOpen: false,
    feedbackText: '',
    rating: 0,
    /** Post-finale catalog («Продолжите путешествие») shown after «что дальше». */
    showCatalog: false,
    /** «Ссылка скопирована» confirmation after a clipboard share fallback. */
    shareToast: false,
    soundOn: typeof window === 'undefined' ? true : localStorage.getItem(SOUND_PREF_KEY) !== 'off',
  }));

  // Lazily-loaded list of other published quests for the post-finale catalog
  // (null = not fetched yet). Thin metadata; see lib/catalog.nextQuestsForCatalog.
  const [published, setPublished] = useState<PublishedQuestWire[] | null>(null);

  const toggleSound = useCallback(() => {
    setUi((u) => {
      localStorage.setItem(SOUND_PREF_KEY, u.soundOn ? 'off' : 'on');
      return { ...u, soundOn: !u.soundOn };
    });
  }, [setUi]);

  const showToast = useCallback((amount: number, narrative?: string, soundOn?: boolean) => {
    dispatch({ type: 'setToast', toast: { amount, narrative } });
    if (soundOn) coinChime();
    setTimeout(() => dispatch({ type: 'setToast', toast: null }), TOAST_MS);
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

  const handlePhysicalConfirm = useCallback(
    (note?: string) => {
      appendFact({
        type: 'physical_confirmed',
        step_position: stepIdx,
        submitted_value: null,
        local_is_correct: true,
        coins_delta: 0,
        note: note || null,
      });
      claimGiftIfNeeded(stepIdx);
      setUi((u) => ({ ...u, note: '' }));
      doAdvance();
    },
    [stepIdx, appendFact, claimGiftIfNeeded, doAdvance, setUi]
  );

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
  }, [hintOfferPos, stepIdx, steps, appendFact]);

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

  // «Начать заново»: supersede the attempt in the queue (facts are never deleted —
  // «монеты останутся»; the completion bonus stays once-ever server-side regardless).
  const handleReplay = useCallback(() => {
    void (async () => {
      try {
        const fresh = await restartAttempt(questId, snapshotId);
        dispatch({ type: 'reset', attemptKey: fresh.attempt_key, attemptCreatedAt: fresh.created_at });
        setUi((u) => ({ ...u, answer: '', wrong: false, note: '', rating: 0, showCatalog: false, shareToast: false }));
      } catch (err) {
        console.warn('restart failed', err);
      }
    })();
  }, [questId, snapshotId, setUi]);

  // Optional finale rating → a structured quest_rated fact, carried through the
  // same offline queue + idempotent sync as every other fact and surfaced to the
  // author via admin version-stats. Last-wins + idempotent: re-rating appends a
  // new fact, the same score never re-appends (mirrors latestRating).
  const recordRating = useCallback(
    (value: number) => {
      if (value <= 0 || latestRating(facts) === value) return;
      appendFact({
        type: 'quest_rated',
        step_position: stepIdx,
        submitted_value: String(value),
        local_is_correct: true,
        coins_delta: 0,
        note: null,
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
    recordRating(ui.rating);
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

  // Flush: upload the queue's pending facts idempotently (lib/sync owns attempt
  // registration + single-flight), then derive the two SPEC corrections by diffing
  // the pre-flush local projection against the authoritative one. On error
  // everything stays pending (client authoritative), retry-safe.
  const runFlush = useCallback(async () => {
    if (!online) return; // real connectivity gates every flush trigger
    dispatch({ type: 'setSyncing', v: true });
    try {
      const result = await flushPending({ questId, playerId: currentPlayerId(), api });
      if (result) {
        const derived = deriveSyncCorrections(result.localBefore, result.authoritative);
        if (derived.balanceNotice || derived.advanceOffer) {
          dispatch({ type: 'setCorrections', corrections: derived });
        }
        if (attemptKey) await refreshQueueStatus(attemptKey);
        dispatch({ type: 'setJustSynced', v: true });
        setTimeout(() => dispatch({ type: 'setJustSynced', v: false }), SYNCED_BANNER_MS);
      }
    } catch (err) {
      console.warn('sync failed — facts stay pending (local authoritative)', err);
    } finally {
      dispatch({ type: 'setSyncing', v: false });
    }
  }, [online, questId, attemptKey, refreshQueueStatus]);

  // Mount: one-time localStorage migration, then hydrate from the queue (single dispatch).
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        await migrateLegacyLocalStorage(questId, snapshotId, window.localStorage);
        const attempt = await ensureActiveAttempt(questId, snapshotId);
        const rows = await getFacts(attempt.attempt_key);
        if (cancelled) return;
        const hydratedFacts = rows.map((r) => r.fact);
        dispatch({
          type: 'hydrate',
          facts: hydratedFacts,
          stepIdx: attempt.last_step_idx,
          attemptKey: attempt.attempt_key,
          attemptCreatedAt: attempt.created_at,
          queueStatus: Object.fromEntries(rows.map((r) => [r.key, r.status])),
          // Start gate (SPEC): only for an in-progress hydrated attempt.
          showStartGate: rows.length > 0 && !hydratedFacts.some((f) => f.type === 'attempt_completed'),
        });
      } catch (err) {
        console.warn('queue hydration failed (in-memory only)', err);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [questId, snapshotId]);

  // Flush once hydrated; refires when connectivity returns (runFlush identity
  // changes with `online`) — "back online" semantics.
  useEffect(() => {
    if (!attemptKey) return;
    void runFlush();
  }, [attemptKey, runFlush]);

  // Resume position write-through (covers every advance path incl. the advance offer).
  useEffect(() => {
    if (!attemptKey) return;
    setLastStepIdx(attemptKey, stepIdx).catch(() => {});
  }, [attemptKey, stepIdx]);

  const closeMenu = () => setUi((u) => ({ ...u, menuOpen: false }));
  const sendFeedback = () => {
    handleFeedback(ui.feedbackText || 'Сообщение об ошибке');
    setUi((u) => ({ ...u, feedbackOpen: false, feedbackText: '' }));
  };

  if (showStartGate) {
    return (
      <StartGate
        title={snapshot.name}
        cover={displaySteps[0]?.image || null}
        createdAt={attemptCreatedAt}
        pos={Math.min(stepIdx + 1, displaySteps.length)}
        total={displaySteps.length}
        version={snapshot.snapshot_version}
        onContinue={() => dispatch({ type: 'dismissStartGate' })}
        onRestart={handleReplay}
      />
    );
  }

  const pos = currentStep.position ?? stepIdx;
  const bannerKind = !online ? 'offline' : isSyncing ? 'syncing' : justSynced ? 'done' : null;
  const questMeta = {
    title: snapshot.name,
    city: 'Нови Сад',
    duration: '90 минут',
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
        note: ui.note,
        rating: ui.rating || latestRating(facts),
        coinsEarned: bal,
        time: formatElapsed(attemptCreatedAt),
        allowNote: currentDisplayStep.allowNote,
      }}
      on={{
        next: () => { setUi((u) => ({ ...u, wrong: false, answer: '' })); doAdvance(); },
        confirm: (note?: string) => handlePhysicalConfirm(note || ui.note || undefined),
        submit: handleAnswerSubmit,
        answer: (v: string) => setUi((u) => ({ ...u, answer: v, wrong: false })),
        note: (e: React.ChangeEvent<HTMLTextAreaElement>) => setUi((u) => ({ ...u, note: e.target.value })),
        buyHint: handleBuyHint,
        navigator: handleNavigator,
        play: () => { /* inline video playback lands with real media refs */ },
        // Tapping a star only updates local state + shows the inline thanks; the
        // single quest_rated fact is committed with the final value on «что дальше».
        rate: (n: number) => setUi((u) => ({ ...u, rating: n })),
        onward: openCatalog,
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
        <TopBar
          pos={pos + 1}
          total={displaySteps.length}
          coins={bal}
          onMenu={() => setUi((u) => ({ ...u, menuOpen: true }))}
        />
      )}
      <div className="p-scroll">{body}</div>
      {bannerKind && <SyncBanner kind={bannerKind} count={pendingCount} />}
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
      {ui.menuOpen && (
        <MenuOverlay
          quest={questMeta}
          copy={COPY}
          st={{ pos: stepIdx + 1, total: displaySteps.length, coins: bal, online, sound: ui.soundOn, pendingCount }}
          on={{
            close: closeMenu,
            feedback: () => setUi((u) => ({ ...u, menuOpen: false, feedbackOpen: true })),
            sync: () => { setUi((u) => ({ ...u, menuOpen: false, syncSheetOpen: true })); void runFlush(); },
            exit: () => router.push('/my-quests'),
            reset: () => { closeMenu(); handleReplay(); },
            sound: toggleSound,
          }}
        />
      )}
      {ui.syncSheetOpen && (
        <SyncSheet
          facts={facts}
          isSent={(f) => queueStatus[factNaturalKey(f)] === 'sent'}
          online={online}
          onClose={() => setUi((u) => ({ ...u, syncSheetOpen: false }))}
        />
      )}
      {corrections?.balanceNotice && (
        <BalanceCorrectionPopup
          notice={corrections.balanceNotice}
          onDismiss={() => dispatch({ type: 'dismissBalanceNotice' })}
        />
      )}
      {!corrections?.balanceNotice && corrections?.advanceOffer && (
        <AdvanceOfferPopup
          offer={corrections.advanceOffer}
          onAccept={() => {
            const target = Math.min(corrections.advanceOffer!.server_step + 1, steps.length - 1);
            dispatch({ type: 'advance', to: target });
            dispatch({ type: 'resolveAdvanceOffer' });
          }}
          onStay={() => dispatch({ type: 'resolveAdvanceOffer' })}
        />
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
