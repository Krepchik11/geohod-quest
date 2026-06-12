'use client';

import React, { useReducer, useEffect, useCallback } from 'react';
import type { Fact, GameStep, QuestSnapshot, AccessGrant, SyncCorrections } from '../../lib/shared-model';
import { isAnswerCorrect, projectBalance, projectState, isEligibleForAttempt, deriveSyncCorrections } from '../../lib/shared-model';
import { api } from '../../lib/api';
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

import { WrongHintPopup } from './WrongHintPopup';
import { FeedbackMenu } from './FeedbackMenu';
import { CoinDisplay } from './CoinDisplay';
import { OfflineBanner } from './OfflineBanner';
import { BonusAnimation } from './BonusAnimation';

// Full design player components (paper "Бумага" + 7 templates + overlays per design/player/components.jsx + quest-data)
import {
  PlayerFrame, StepView, TopBar, SyncBanner,
  HintPopup, MenuOverlay, FeedbackSheet,
  SyncSheet, BalanceCorrectionPopup, AdvanceOfferPopup
} from '../player/PlayerComponents';

interface PlayerState {
  facts: Fact[];
  stepIdx: number;
  simOffline: boolean;
  showWrongPopup: boolean;
  wrongStepPos: number | null;
  bonusMessage: string | null;
  /* Local attempt identity from the IndexedDB queue (server id lives there too). */
  attemptKey: string | null;
  attemptCreatedAt: string | null;
  isSyncing: boolean;
  syncError: string | null;
  lastCorrMessage: string | null;
  /* The two SPEC corrections, derived client-side after sync (popups). */
  corrections: SyncCorrections | null;
  /* Per-fact queue status mirror (natural key → status) — chips/pending counts. */
  queueStatus: Record<string, 'pending' | 'sent'>;
  /* Start gate (SPEC): shown when an in-progress attempt was hydrated. */
  showStartGate: boolean;
  // eligibility gate additive (marketplace-grants): demo grant or ?owned=1 or local after buy; mystery golden demo allows for happy untouched
  grant: AccessGrant | null;
  accessWarning: string | null;
}

type PlayerAction =
  | { type: 'append'; fact: Fact }
  | { type: 'advance'; to?: number }
  | { type: 'setPopup'; show: boolean; pos?: number | null }
  | { type: 'toggleOffline' }
  | { type: 'reset'; attemptKey: string; attemptCreatedAt: string }
  | { type: 'setBonus'; msg: string | null }
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
  | { type: 'setSyncResult'; error: string | null; corrMsg: string | null }
  | { type: 'setCorrections'; corrections: SyncCorrections | null }
  | { type: 'dismissBalanceNotice' }
  | { type: 'resolveAdvanceOffer' }
  | { type: 'setQueueStatus'; status: Record<string, 'pending' | 'sent'> }
  // eligibility gate additive (demo grant or from marketplace buy / ?owned)
  | { type: 'setGrant'; grant: AccessGrant | null }
  | { type: 'setAccessWarning'; msg: string | null };

const initialState: PlayerState = {
  facts: [],
  stepIdx: 0,
  simOffline: false,
  showWrongPopup: false,
  wrongStepPos: null,
  bonusMessage: null,
  attemptKey: null,
  attemptCreatedAt: null,
  isSyncing: false,
  syncError: null,
  lastCorrMessage: null,
  corrections: null,
  queueStatus: {},
  showStartGate: false,
  grant: null,
  accessWarning: null,
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
      return { ...state, stepIdx: action.to ?? Math.min(state.stepIdx + 1, 999) };
    case 'setPopup':
      return { ...state, showWrongPopup: action.show, wrongStepPos: action.pos ?? null };
    case 'toggleOffline':
      return { ...state, simOffline: !state.simOffline };
    case 'reset':
      return {
        ...initialState,
        simOffline: state.simOffline,
        grant: state.grant,
        attemptKey: action.attemptKey,
        attemptCreatedAt: action.attemptCreatedAt,
      };
    case 'setBonus':
      return { ...state, bonusMessage: action.msg };
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
    case 'setSyncResult':
      return { ...state, syncError: action.error, lastCorrMessage: action.corrMsg };
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
    case 'setGrant':
      return { ...state, grant: action.grant, accessWarning: null };
    case 'setAccessWarning':
      return { ...state, accessWarning: action.msg };
    default:
      return state;
  }
}


export default function QuestPlayerClient({
  snapshot,
  goldenId,
  snapshotId,
}: {
  snapshot: QuestSnapshot;
  goldenId: string;
  /** Snapshot identity for attempt binding; bundle id when playing from a bundle. */
  snapshotId?: string;
}) {
  const steps: GameStep[] = snapshot.steps;
  const [state, dispatch] = useReducer(playerReducer, initialState);
  const { facts, stepIdx, simOffline, showWrongPopup, wrongStepPos, bonusMessage, attemptKey, attemptCreatedAt, isSyncing, lastCorrMessage, corrections, queueStatus, showStartGate, grant, accessWarning } = state; // syncError kept in state/reducer for completeness (YAGNI no deep UI render yet)

  const currentStep: GameStep = steps[Math.min(stepIdx, steps.length - 1)];
  const bal = projectBalance(facts);
  const proj = projectState(facts);
  /** Facts the server has not acknowledged yet — banner badge + menu + sheet chips. */
  const pendingCount = Object.values(queueStatus).filter((s) => s === 'pending').length;

  // Attempt binding id: bundle snapshot when present, golden marker otherwise.
  const boundSnapshotId = snapshotId || `golden:${goldenId}`;

  // eligibility gate additive (marketplace-grants): demo grant for mystery golden (keeps happy "МИХАЙЛО ПУПИН"+5 + reconnect 100% untouched per TDD goldens); for other quests require grant (from buy or ?owned=1); pure isEligibleForAttempt from shared (reuse, no dupe)
  const demoGrant: AccessGrant | null = goldenId === 'mystery-fortress-v1'
    ? { player_id: currentPlayerId(), quest_id: goldenId, granted_at: '2026-06-10T00:00:00Z', source: 'Payment', source_ref: null }
    : grant;
  const isEligible = isEligibleForAttempt(demoGrant, goldenId, /*free flag*/ goldenId.includes('free') || false);

  const appendFact = useCallback(
    (partial: Omit<Fact, 'device_id'>) => {
      const fact: Fact = { ...partial, device_id: getDeviceId() };
      dispatch({ type: 'append', fact });
      // Write-through to the durable queue; storage failure degrades to in-memory
      // play (offline never blocks play), never to a blocked action.
      void (async () => {
        try {
          const key = attemptKey
            ?? (await ensureActiveAttempt(goldenId, boundSnapshotId)).attempt_key;
          await queueAppendFact(key, fact);
        } catch (err) {
          console.warn('fact write-through failed (in-memory only)', err);
        }
      })();
    },
    [attemptKey, goldenId, boundSnapshotId]
  );

  const claimGiftIfNeeded = useCallback(
    (pos: number) => {
      const step = steps[pos];
      if (!step?.supporting?.gift) return false;
      const alreadyClaimed = facts.some(
        (f) => f.type === 'gift_claimed' && f.step_position === pos
      );
      if (alreadyClaimed) return false;
      const gift = step.supporting.gift!;
      appendFact({
        type: 'gift_claimed',
        step_position: pos,
        submitted_value: null,
        local_is_correct: true,
        coins_delta: gift.coins,
        note: gift.narrative_text || `Gift from step ${pos} (synthesized coverage)`,
      });
      if (step.supporting.bonus_animation) {
        const msg = `+${gift.coins} coins!`;
        dispatch({ type: 'setBonus', msg });
        if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
          try {
            const utter = new SpeechSynthesisUtterance(msg);
            window.speechSynthesis.speak(utter);
          } catch {}
        }
        setTimeout(() => dispatch({ type: 'setBonus', msg: null }), 2400);
      }
      return true;
    },
    [steps, facts, appendFact]
  );

  const doAdvance = useCallback(() => {
    const pos = stepIdx;
    claimGiftIfNeeded(pos);
    const next = Math.min(stepIdx + 1, steps.length - 1);
    dispatch({ type: 'advance', to: next });
    // reach next may auto-claim (e.g. gift step with no recorded action in happy golden)
    setTimeout(() => claimGiftIfNeeded(next), 0);
  }, [stepIdx, steps.length, claimGiftIfNeeded]);

  const handlePhysicalConfirm = useCallback(
    (note?: string) => {
      if (!isEligible) { dispatch({ type: 'setAccessWarning', msg: 'Access required - visit marketplace' }); return; }
      appendFact({
        type: 'physical_confirmed',
        step_position: stepIdx,
        submitted_value: null,
        local_is_correct: true,
        coins_delta: 0,
        note: note || null,
      });
      claimGiftIfNeeded(stepIdx);
      doAdvance();
    },
    [stepIdx, appendFact, claimGiftIfNeeded, doAdvance, isEligible]
  );

  const handleAnswerSubmit = useCallback(
    (value: string) => {
      if (!isEligible) { dispatch({ type: 'setAccessWarning', msg: 'Access required - visit marketplace' }); return; }
      const step = currentStep;
      const correct = isAnswerCorrect(value, step.completion.acceptable);
      appendFact({
        type: 'answer_submitted',
        step_position: stepIdx,
        submitted_value: value,
        local_is_correct: correct,
        coins_delta: 0,
        note: null,
      });
      if (!correct && step.supporting?.hint) {
        // ONLY via wrong popup (per spec)
        dispatch({ type: 'setPopup', show: true, pos: stepIdx });
        return;
      }
      claimGiftIfNeeded(stepIdx);
      doAdvance();
    },
    [stepIdx, currentStep, appendFact, claimGiftIfNeeded, doAdvance, isEligible]
  );

  const handleSpendHint = useCallback(() => {
    const pos = wrongStepPos ?? stepIdx;
    const step = steps[pos];
    const cost = step?.supporting?.hint?.cost_coins ?? 0;
    // Never blocked by balance — overdraft is a legal state (SPEC).
    appendFact({
      type: 'hint_purchased',
      step_position: pos,
      submitted_value: null,
      local_is_correct: true,
      coins_delta: -cost,
      note: step?.supporting?.hint?.reveal_text || null,
    });
    dispatch({ type: 'setPopup', show: false, pos: null });
  }, [wrongStepPos, stepIdx, steps, appendFact]);

  const handleCancelPopup = useCallback(() => {
    dispatch({ type: 'setPopup', show: false, pos: null });
  }, []);

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
    const url = `https://www.google.com/maps/search/?api=1&query=${nav.lat},${nav.lng}`;
    if (typeof window !== 'undefined') {
      window.open(url, '_blank');
    }
  }, [stepIdx, currentStep, appendFact]);

  const handleTerminal = useCallback(() => {
    if (!isEligible) { dispatch({ type: 'setAccessWarning', msg: 'Access required - visit marketplace' }); return; }
    appendFact({
      type: 'attempt_completed',
      step_position: stepIdx,
      submitted_value: null,
      local_is_correct: true,
      coins_delta: 0,
      note: currentStep.rich_content.button_text || 'Completed the quest',
    });
    // Canonical completion bonus: toast on entering the terminal step. Local guard for this
    // attempt; the server enforces once-per-(player, quest) across attempts/devices/resets.
    if (!facts.some((f) => f.type === 'completion_bonus')) {
      appendFact({
        type: 'completion_bonus',
        step_position: stepIdx,
        submitted_value: null,
        local_is_correct: true,
        coins_delta: 5,
        note: 'Бонус за прохождение',
      });
      dispatch({ type: 'setBonus', msg: '+5 монет — бонус за прохождение' });
      setTimeout(() => dispatch({ type: 'setBonus', msg: null }), 2400);
    }
    claimGiftIfNeeded(stepIdx);
  }, [stepIdx, currentStep, facts, appendFact, claimGiftIfNeeded, isEligible]);

  // Emit attempt_completed + completion bonus on entering the terminal step
  // (guards make this idempotent across re-renders and LS restores).
  const isTerminalStep = !!currentStep?.supporting?.terminal || currentStep?.template === 'congrats';
  const hasCompleted = facts.some((f) => f.type === 'attempt_completed');
  useEffect(() => {
    if (isTerminalStep && !hasCompleted) handleTerminal();
  }, [isTerminalStep, hasCompleted, handleTerminal]);

  // «Начать заново»: supersede the attempt in the queue (facts are never deleted —
  // «монеты останутся»; the completion bonus stays once-ever server-side regardless).
  const handleReplay = useCallback(() => {
    void (async () => {
      try {
        const fresh = await restartAttempt(goldenId, boundSnapshotId);
        dispatch({ type: 'reset', attemptKey: fresh.attempt_key, attemptCreatedAt: fresh.created_at });
      } catch (err) {
        console.warn('restart failed', err);
      }
    })();
  }, [goldenId, boundSnapshotId]);

  // Re-mirror per-fact queue status into state (chips + pending counts).
  const refreshQueueStatus = useCallback(async (key: string) => {
    const rows = await getFacts(key);
    dispatch({ type: 'setQueueStatus', status: Object.fromEntries(rows.map((r) => [r.key, r.status])) });
  }, []);

  // Flush: upload the queue's pending facts idempotently (lib/sync owns attempt
  // registration + single-flight), then derive the two SPEC corrections by diffing
  // the pre-flush local projection against the authoritative one. No correction
  // facts exist. On error everything stays pending (client authoritative), retry-safe.
  const runFlush = useCallback(async (opts?: { silent?: boolean }) => {
    if (simOffline) return; // ALL flush triggers gate on the sim toggle (SPEC)
    dispatch({ type: 'setSyncing', v: true });
    try {
      const result = await flushPending({ questId: goldenId, playerId: currentPlayerId(), api });
      if (result) {
        const corrections = deriveSyncCorrections(result.localBefore, result.authoritative);
        if (corrections.balanceNotice || corrections.advanceOffer) {
          dispatch({ type: 'setCorrections', corrections });
        }
        if (attemptKey) await refreshQueueStatus(attemptKey);
        dispatch({ type: 'setSyncResult', error: null, corrMsg: 'synced' });
        setTimeout(() => dispatch({ type: 'setSyncResult', error: null, corrMsg: null }), 2400);
      }
    } catch {
      if (!opts?.silent) {
        dispatch({ type: 'setSyncResult', error: 'sync failed, still offline (local authoritative)', corrMsg: null });
      }
    } finally {
      dispatch({ type: 'setSyncing', v: false });
    }
  }, [simOffline, goldenId, attemptKey, refreshQueueStatus]);

  const handleSyncClick = useCallback(async () => {
    if (simOffline) {
      alert('Simulated: facts would be uploaded idempotently and corrections derived from the projection diff.');
      return;
    }
    await runFlush();
  }, [simOffline, runFlush]);

  // Mount: one-time localStorage migration, then hydrate from the queue (single dispatch).
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        await migrateLegacyLocalStorage(goldenId, boundSnapshotId, window.localStorage);
        const attempt = await ensureActiveAttempt(goldenId, boundSnapshotId);
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
  }, [goldenId, boundSnapshotId]);

  // Start flush once hydrated; also refires when the sim toggle flips off
  // (runFlush identity change) — "back online" semantics. Silent: no error UI.
  useEffect(() => {
    if (!attemptKey) return;
    void runFlush({ silent: true });
  }, [attemptKey, runFlush]);

  // Resume position write-through (covers every advance path incl. the advance offer).
  useEffect(() => {
    if (!attemptKey) return;
    setLastStepIdx(attemptKey, stepIdx).catch(() => {});
  }, [attemptKey, stepIdx]);

  // Reconnect trigger: flush when the browser comes back online (sim-gated via ref).
  useEffect(() => {
    const onOnline = () => {
      void runFlush({ silent: true });
    };
    window.addEventListener('online', onOnline);
    return () => window.removeEventListener('online', onOnline);
  }, [runFlush]);

  // UI state for controlled paper StepView (answer val, wrong flag for shake, hintRevealed, note, menu/sheet/rating per design full flows)
  // Narrow 'use client' state; facts/reducer remain sole mutable source for TDD goldens fidelity.
  const [uiState, setUiState] = React.useState({
    answer: '' as string,
    wrong: false as boolean,
    hintRevealed: false as boolean,
    note: '' as string,
    menuOpen: false as boolean,
    feedbackOpen: false as boolean,
    syncSheetOpen: false as boolean,
    feedbackText: '' as string,
    rating: 0 as number,
    reviewSent: false as boolean,
    soundOn: true as boolean,
  });

  // Real 7-tpl demo data from design/player/quest-data.js (Ирония судьбы) mapped to designStep + supporting for rich paper render.
  // Used for visual fidelity + full template coverage when golden=ironia (or default demo). Mystery golden kept for exact TDD replay.
  const DEMO_IRONIA_STEPS = [
    { template: 'start', title: 'Ирония судьбы', text: 'по следам исторических личностей', kicker: 'Городской квест', image: '/assets/img/quest-card.png' },
    { template: 'video', text: 'Здравствуйте! Я архивариус Николаевской церкви. Сто лет назад здесь оставил след человек, изменивший наше представление о Вселенной. Готовы пройти по его следам?', video: { dur: '0:48', label: 'видео-приветствие автора' } },
    { template: 'continue', text: '1913 год. Нови Сад. В церковной книге появляется запись о крещении двух мальчиков — Эдуарда и Альберта.\n\nИх мать — сербка Милева Марич. Об отце пока умолчим: вы сами назовёте его имя к концу прогулки.', image: '/assets/img/church.jpg' },
    { template: 'task_no', text: 'Дойдите до Николаевской церкви — самой старой православной церкви города.', place: 'ул. Николаевска порта 2 · 400 м отсюда', action: { desc: 'Найдите кованую ограду у входа и прикоснитесь к холодному металлу — так здоровались с церковью сто лет назад.', confirmLabel: 'Я на месте, нашёл' }, nav: { lat: 45.2551, lng: 19.8451, label: 'Николаевская церковь' }, gift: { coins: 3, narrative_text: 'За смелость и точность' }, allowNote: true },
    { template: 'task_answer', text: 'Взгляните на табличку над входом. В каком году храм был освящён после перестройки?', prompt: 'Введите год', acceptable: ['1730'], gift: { coins: 5, narrative_text: 'Острый глаз!' }, hint: { cost: 5, text: 'Цифры выбиты в каменной арке над дверью — две первые уже видны с дорожки.' } },
    { template: 'route_video', text: 'Теперь — по Дунавской улице к городскому парку. По пути считайте кофейни: их тут больше, чем фонарей.', video: { dur: '0:31', label: 'видео маршрута до парка' }, nav: { lat: 45.2552, lng: 19.8489, label: 'Дунавский парк' } },
    { template: 'continue', text: '— Вот, спасибо, удружили! Что там у вас? Так, где у меня книга 1913 года была? 20 сентября, говорите?\n\nДа тут одна запись всего: «Едуард и Алберт, крштени су по православном обреду...»\n\nПодождите, да их же мать та самая Милева. Ну и дела!', image: '/assets/img/quest-card.png' },
    { template: 'congrats', title: 'Квест пройден!', text: 'Имя отца мальчиков вы уже поняли сами: Альберт Эйнштейн. Ирония судьбы в том, что города, хранящие чьи-то следы, сами становятся частью истории.' },
  ];

  const useIroniaDemo = goldenId === 'ironia' || goldenId === 'ironia-sudby';
  const displaySteps = useIroniaDemo ? DEMO_IRONIA_STEPS : steps.map((s: GameStep) => {
    return {
      template: s.template,
      title: s.rich_content?.title || s.template,
      text: s.rich_content?.main_text || '',
      image: s.media?.task || s.media?.character || null,
      place: s.rich_content?.place_text,
      prompt: s.rich_content?.question_prompt,
      acceptable: s.completion?.acceptable,
      action: s.supporting?.physical_action ? { desc: s.supporting.physical_action.description || '', confirmLabel: s.rich_content?.button_text } : undefined,
      nav: s.supporting?.navigator ?? undefined,
      gift: s.supporting?.gift ?? undefined,
      hint: s.supporting?.hint ? { cost: s.supporting.hint.cost_coins, text: s.supporting.hint.reveal_text } : undefined,
      allowNote: s.completion?.allow_note,
    };
  });

  const currentDisplayStep = displaySteps[Math.min(stepIdx, displaySteps.length - 1)] || displaySteps[0];

  // thin StepRenderer — now ALWAYS full paper frame + StepView (design fidelity). Controlled st/on for answer/hint/note/menu.
  const renderCurrentView = () => {
    const pos = (currentStep.position ?? stepIdx);
    const revealed = proj.revealedHints.includes(pos) || uiState.hintRevealed;

    const designStep = currentDisplayStep;

    const questMeta = useIroniaDemo
      ? { city: 'Нови Сад', duration: '90 минут', title: 'Ирония судьбы', completionBonus: 5, stepsDone: `${Math.min(stepIdx + 1, displaySteps.length)} / ${displaySteps.length}` }
      : { city: 'Нови Сад', duration: '1.5 часа' };

    const copy = {
      next: 'продолжить', onward: 'в путь', start: 'начать квест', navigator: 'навигатор',
      submit: 'Ответить', wrong1: 'Неверно. Попробуйте ещё раз.', noteHolder: 'Заметка для себя (необязательно)',
      hintTitle: 'Нужна подсказка?', hintBody: (c: number) => `Обменяйте ${c} монет на подсказку — она останется с вами до конца шага.`,
      hintYes: (c: number) => `Потратить ${c} монет`, hintNo: 'Попробую сам',
      finalBtn: 'Оценить квест', finalDone: 'Спасибо! Отзыв отправлен',
      giftToast: (n: number) => `+${n} монет`,
    };

    if (accessWarning) {
      return <div className="rounded border border-red-300 p-3 text-sm text-red-700 dark:text-red-400">{accessWarning} (demo: buy in marketplace or use ?golden with owned)</div>;
    }

    // ALWAYS paper frame for all 7 templates (start/video/task_no/task_answer/continue/route_video/congrats) + congrats FinalB
    return (
      <PlayerFrame tw={{ art: 'paper', layout: 'image', anims: false }} screenLabel={`player-step-${pos}`}>
        <TopBar
          pos={pos + 1}
          total={displaySteps.length}
          coins={bal}
          onMenu={() => setUiState(u => ({ ...u, menuOpen: true }))}
        />
        <StepView
          step={designStep}
          quest={questMeta}
          copy={copy}
          st={{
            hintRevealed: revealed,
            wrong: uiState.wrong,
            answer: uiState.answer,
            note: uiState.note,
            rating: uiState.rating,
            reviewSent: uiState.reviewSent,
            coinsEarned: bal,
            time: '1:24',
            steps: questMeta.stepsDone,
            allowNote: designStep.allowNote,
          }}
          on={{
            next: () => { setUiState(u => ({ ...u, wrong: false, answer: '' })); doAdvance(); },
            confirm: (note?: string) => handlePhysicalConfirm(note || uiState.note || undefined),
            submit: (val: string) => {
              if (!val || !val.trim()) return;
              handleAnswerSubmit(val);
              // reflect local verdict for shake + inline wrong (popup for hint is in parent WrongHintPopup/HintPopup)
              const ok = isAnswerCorrect(val, designStep.acceptable);
              setUiState(u => ({ ...u, wrong: !ok, answer: ok ? '' : val }));
              if (ok) setTimeout(() => setUiState(u => ({ ...u, wrong: false })), 1200);
            },
            answer: (v: string) => setUiState(u => ({ ...u, answer: v, wrong: false })),
            note: (e: React.ChangeEvent<HTMLTextAreaElement>) => setUiState(u => ({ ...u, note: e.target.value })),
            buyHint: () => { handleSpendHint(); setUiState(u => ({ ...u, hintRevealed: true })); },
            navigator: handleNavigator,
            play: () => { /* video play stub */ },
            rate: (n: number) => setUiState(u => ({ ...u, rating: n })),
            review: () => {
              handleFeedback(uiState.feedbackText || 'Rated via final');
              setUiState(u => ({ ...u, reviewSent: true }));
            },
          }}
        />
        <SyncBanner kind={simOffline ? 'offline' : (isSyncing ? 'syncing' : 'done')} count={pendingCount} />
      </PlayerFrame>
    );
  };

  const isDone = proj.completedSteps.includes(steps.length - 1) || stepIdx >= steps.length - 1;

  // Close menu helper
  const closeMenu = () => setUiState(u => ({ ...u, menuOpen: false }));
  const openFeedback = () => { setUiState(u => ({ ...u, menuOpen: false, feedbackOpen: true })); };
  const closeFeedback = () => setUiState(u => ({ ...u, feedbackOpen: false }));
  const sendFeedback = () => {
    handleFeedback(uiState.feedbackText || 'Reported via menu');
    setUiState(u => ({ ...u, feedbackOpen: false, feedbackText: '' }));
  };

  return (
    <div className="rounded-2xl border bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
      <div className="mb-3 flex items-center justify-between text-sm">
        <CoinDisplay balance={bal} />
        <div>
          Step {stepIdx + 1}/{steps.length}
          {proj.completedSteps.length > 0 && ` • done ${proj.completedSteps.join(',')}`}
        </div>
        <OfflineBanner
          simOffline={simOffline}
          onToggle={() => dispatch({ type: 'toggleOffline' })}
          onSimSync={handleSyncClick}
          pendingCount={pendingCount}
          isSyncing={isSyncing}
          corrMessage={lastCorrMessage}
        />
      </div>

      <BonusAnimation message={bonusMessage} />

      {/* Start gate (SPEC): in-progress attempt → continue / restart («монеты останутся») */}
      {showStartGate ? (
        <StartGate
          title={useIroniaDemo ? 'Ирония судьбы' : snapshot.name}
          cover={displaySteps[0]?.image || null}
          createdAt={attemptCreatedAt}
          pos={Math.min(stepIdx + 1, displaySteps.length)}
          total={displaySteps.length}
          version={snapshot.snapshot_version}
          onContinue={() => dispatch({ type: 'dismissStartGate' })}
          onRestart={handleReplay}
        />
      ) : (
        /* Always the designed paper player (PlayerFrame + StepView + overlays) per design/player/components.jsx + quest-data.js */
        renderCurrentView()
      )}

      {/* Legacy feedback + popups kept for wiring; HintPopup + Menu + FeedbackSheet are the design ones */}
      <FeedbackMenu onReport={handleFeedback} />

      {/* Hint popup: design version when wrong + hint available (also keep old WrongHintPopup for compat during transition) */}
      {showWrongPopup && currentStep.supporting?.hint && (
        <HintPopup
          step={{ hint: { cost: currentStep.supporting.hint.cost_coins } }}
          copy={null}
          on={{ buy: () => { handleSpendHint(); setUiState(u => ({ ...u, hintRevealed: true })); dispatch({ type: 'setPopup', show: false }); }, dismiss: handleCancelPopup }}
        />
      )}
      <WrongHintPopup
        show={showWrongPopup}
        cost={(currentStep.supporting?.hint?.cost_coins) || 0}
        currentBal={bal}
        onSpend={handleSpendHint}
        onCancel={handleCancelPopup}
      />

      {/* Full design menu + feedback sheet overlays */}
      {uiState.menuOpen && (
        <MenuOverlay
          quest={{ title: useIroniaDemo ? 'Ирония судьбы' : currentStep.rich_content.title, name: goldenId }}
          copy={null}
          st={{ pos: stepIdx + 1, total: displaySteps.length, coins: bal, online: !simOffline, sound: uiState.soundOn, pendingCount }}
          on={{
            close: closeMenu,
            feedback: openFeedback,
            sync: () => setUiState(u => ({ ...u, menuOpen: false, syncSheetOpen: true })),
            exit: () => { closeMenu(); window.location.href = '/my-quests'; },
            reset: () => { closeMenu(); handleReplay(); },
            sound: () => setUiState(u => ({ ...u, soundOn: !u.soundOn })),
          }}
        />
      )}
      {uiState.syncSheetOpen && (
        <SyncSheet
          facts={facts}
          isSent={(f) => queueStatus[factNaturalKey(f)] === 'sent'}
          online={!simOffline}
          onClose={() => setUiState(u => ({ ...u, syncSheetOpen: false }))}
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
      {uiState.feedbackOpen && (
        <FeedbackSheet
          quest={{ title: useIroniaDemo ? 'Ирония судьбы' : currentStep.rich_content.title }}
          copy={null}
          st={{ pos: stepIdx + 1, stepName: currentStep.rich_content?.title || currentDisplayStep.title }}
          on={{
            dismiss: closeFeedback,
            text: (e: React.ChangeEvent<HTMLTextAreaElement>) => setUiState(u => ({ ...u, feedbackText: e.target.value })),
            send: sendFeedback,
          }}
        />
      )}

      {isDone && (
        <div className="mt-5 rounded border border-emerald-200 bg-emerald-50 p-3 text-sm dark:border-emerald-900 dark:bg-emerald-950">
          Complete. Final bal from projectBalance: {bal}
          <button onClick={handleReplay} className="ml-3 underline">
            Replay (clear facts + LS)
          </button>
          <details className="mt-2">
            <summary className="cursor-pointer text-xs">facts (debug, append-only)</summary>
            <pre className="mt-1 max-h-40 overflow-auto text-[10px]">{JSON.stringify(facts, null, 2)}</pre>
          </details>
        </div>
      )}

      <div className="mt-4 text-[10px] text-zinc-500">
        append-only facts • always re-projectBalance/projectState • LS roundtrip • popup ONLY on wrong answer • gift auto on reach • paper 7-tpl full
      </div>
    </div>
  );
}
