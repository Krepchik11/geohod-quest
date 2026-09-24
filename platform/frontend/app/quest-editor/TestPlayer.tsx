'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { serializeDraft, type CtorQuest } from '../../lib/constructor-model';
import { elapsedLabel, toDesignStep } from '../../lib/design-step';
import type { QuestTheme } from '../../lib/quest-theme';
import { skipCost as snapshotSkipCost, theme as snapshotTheme } from '../../lib/snapshot';
import { latestRating, projectState, solvedAnswerAt, wrongPopupAt, type GameStep, type QuestSnapshot } from '../../lib/shared-model';
import {
  COMPLETION_BONUS,
  NO_EARNED_BONUSES,
  hydratedPlayState,
  isTerminalStep,
  transition,
  type PlayCtx,
  type PlayEvent,
  type PlayState,
} from '../../lib/play-loop';
import { PLAYER_COPY } from '../../lib/player-copy';
import {
  CoinToast,
  FeedbackSheet,
  HintPopup,
  HintRevealPopup,
  MenuOverlay,
  PlayerFrame,
  StepView,
  TopBar,
  type DesignStep,
} from '../player/PlayerComponents';
import { coinChime, spendChime } from '../quest/sound';
import { useEscape } from './controls';

/**
 * Тест-игрок конструктора: играет ЧЕРНОВИК настоящими компонентами плеера и
 * тем же движком (lib/play-loop): список шага + универсальный ответ квеста.
 * Снапшот берётся на момент запуска, прогресс
 * эфемерный — dry-run будущей версии (design/ctor2/test-player.jsx).
 */

const TOAST_MS = 1900;
const NAV_TOAST_MS = 2600;

interface TestQuest {
  title: string;
  city: string;
  duration: string;
  /** Канонические GameStep из stepToGameStep — вход движка (lib/play-loop). */
  steps: GameStep[];
  /** Те же шаги в форме отображения StepView. */
  display: DesignStep[];
  /** Универсальный ответ квеста из настроек. Платформенный универсальный
   *  ответ в тесте черновика сознательно не участвует — он рантайм-настройка
   *  админа, а не часть квеста. */
  universalAnswer: QuestSnapshot['universal_answer'];
  /** Цвета квеста — тест показывает их так же, как их увидит игрок. */
  theme: QuestTheme | null;
  /** Цена «Пропустить задание» — тем же читателем снапшота, что и у игрока. */
  skipCost: number;
}

/** Меты теста («на паузе», «окончен») — состояния самого прогона, а не квеста,
 *  поэтому живут здесь, а не в PlayerComponents. Одна разметка на оба. */
function TestPopup({ title, text, primary, ghost }: {
  title: string;
  text: string;
  primary: { label: string; on: () => void };
  ghost: { label: string; on: () => void };
}) {
  return (
    <div className="p-overlay">
      <div className="p-popup">
        <p className="p-popup__title">{title}</p>
        <p className="p-popup__text">{text}</p>
        <button className="p-btn" type="button" onClick={primary.on}>{primary.label}</button>
        <button className="p-btn p-btn--ghost" type="button" onClick={ghost.on}>{ghost.label}</button>
      </div>
    </div>
  );
}

function DraftRun({ quest, startPos, onNav }: { quest: TestQuest; startPos: number; onNav: (msg: string) => void }) {
  const total = quest.steps.length;
  const clamp = (n: number) => Math.max(0, Math.min(n, total - 1));
  const ctx: PlayCtx = {
    steps: quest.steps,
    deviceId: 'test-player',
    universalAnswers: [quest.universalAnswer],
    earnedBonuses: NO_EARNED_BONUSES,
    skipCost: quest.skipCost,
  };

  // ONE rule state — the same engine the real player runs (lib/play-loop).
  // Старт прямо с «Поздравления» сразу даёт терминальный бонус (как в дизайне):
  // transition чистая, поэтому вход в терминал складывается прямо в старт.
  const initialRun = (): PlayState => {
    const base = hydratedPlayState([], clamp(startPos));
    return isTerminalStep(quest.steps[base.stepIdx])
      ? transition(base, { type: 'enter_terminal' }, ctx).state
      : base;
  };
  const [play, setPlay] = useState<PlayState>(initialRun);
  const [sound, setSound] = useState(true);
  const [rating, setRating] = useState(0);
  const [reviewText, setReviewText] = useState('');
  const [startTs, setStartTs] = useState(() => Date.now());
  const [finalTime, setFinalTime] = useState('0:00');
  const [answer, setAnswer] = useState('');
  const [feedbackText, setFeedbackText] = useState('');
  const [wrongFlash, setWrongFlash] = useState(false);
  const [toast, setToast] = useState<{ amount: number; narrative?: string } | null>(null);
  const [overlay, setOverlay] = useState<'menu' | 'feedback' | 'paused' | 'over' | null>(null);

  const pos = play.stepIdx;
  const step = quest.steps[pos];
  const display = quest.display[pos];
  // Прогон эфемерный — факты живут только в play.facts и умирают с оверлеем.
  const proj = projectState(play.facts);
  const coins = proj.balance;

  // One shared dismiss timer (mirrors the real player): a new toast restarts the
  // clock, so a step gift's pending clear can't wipe a hint spend toast shown on
  // the very next step before its own 1.9s elapses.
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
  }, []);
  const showToast = (amount: number, narrative?: string) => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setToast({ amount, narrative });
    if (sound) (amount < 0 ? spendChime : coinChime)();
    toastTimer.current = setTimeout(() => setToast(null), TOAST_MS);
  };

  /** Единственный путь правил: transition движка → стейт + слив эффектов.
   *  Приземление на терминал движок завершает сам (бонус один раз —
   *  идемпотентно по логу), поэтому эффектов-на-стейт нет. */
  const runEvent = (event: PlayEvent) => {
    const result = transition(play, event, ctx);
    setPlay(result.state);
    if (result.effects.appended.some((f) => f.type === 'attempt_completed')) {
      setFinalTime(elapsedLabel(startTs, Date.now()));
    }
    if (result.effects.toast) showToast(result.effects.toast.amount, result.effects.toast.narrative);
    if (result.effects.advanced) {
      setAnswer('');
      setWrongFlash(false);
    }
    if (result.effects.openMaps) {
      onNav(`→ Системные карты: ${result.effects.openMaps.label || 'точка'} · ${result.effects.openMaps.lat}, ${result.effects.openMaps.lng}`);
    }
    if (result.effects.answered && !result.effects.answered.correct) setWrongFlash(true);
    return result;
  };

  const next = () => runEvent({ type: 'advance_to', to: pos + 1 });
  // View rewind, mirroring the real player: authors test the same "go back and
  // reread" affordance. The engine's log guards stay idempotent.
  const back = () => {
    setAnswer('');
    setWrongFlash(false);
    runEvent({ type: 'back' });
  };

  const reset = () => {
    setPlay(initialRun());
    setRating(0);
    setReviewText('');
    setOverlay(null);
    setAnswer('');
    setWrongFlash(false);
    setStartTs(Date.now());
    setFinalTime('0:00');
  };

  // Попап неверного ответа: состав решает то же правило, что и в плеере.
  const popupPos = play.hintOfferPos;
  const wrongPopup = popupPos != null ? wrongPopupAt(play.facts, popupPos, quest.steps[popupPos]) : null;
  const revealedHint = play.hintRevealPos != null ? quest.display[play.hintRevealPos].hint : null;

  const handlers = {
    next,
    play: () => {},
    navigator: () => runEvent({ type: 'navigator' }),
    answer: (value: string) => { setAnswer(value); setWrongFlash(false); },
    /** Единственный путь покупки — и для чипа на странице, и для попапа после
     *  ошибки (в плеере это тот же buy_hint). */
    buyHint: () => runEvent({ type: 'buy_hint' }),
    confirm: () => runEvent({ type: 'physical_confirm' }),
    submit: (value: string) => runEvent({ type: 'answer', value }),
    // Первое касание звезды платит за оценку — ровно как в плеере, чтобы автор
    // видел ту же анимацию монет; дальнейшие смены звёзд только локальные.
    rate: (n: number) => {
      setRating(n);
      if (latestRating(play.facts) === 0) runEvent({ type: 'rate', value: n, text: null });
    },
    reviewText: setReviewText,
    // В плеере отсюда игрок уходит в магазин; в черновике магазина нет — тест
    // на этом заканчивается.
    onward: () => setOverlay('over'),
  };

  const stepState = {
    answer,
    wrong: wrongFlash,
    // Решённое задание — то же правило, что и у игрока (shared-model).
    solved: solvedAnswerAt(play.facts, pos),
    hintRevealed: proj.revealedHints.includes(pos),
    coinsEarned: coins,
    time: finalTime,
    steps: `${total} / ${total}`,
    rating,
    reviewText,
  };

  return (
    <PlayerFrame tw={{ anims: false }} screenLabel={'Тест: ' + (display.title || display.template)} theme={quest.theme}>
      {step.template !== 'start' ? (
        <TopBar pos={pos + 1} total={total} coins={coins} onMenu={() => setOverlay('menu')} onBack={pos > 0 ? back : undefined} />
      ) : null}

      {/* The same scroll container the real player uses (QuestPlayerClient):
          .pframe clips overflow, so without it a tall draft step is unscrollable. */}
      <div className="p-scroll">
        <StepView
          step={display}
          quest={{ title: quest.title, city: quest.city, duration: quest.duration, completionBonus: COMPLETION_BONUS }}
          copy={PLAYER_COPY}
          st={stepState}
          on={handlers}
        />
      </div>

      {toast ? <CoinToast amount={toast.amount} narrative={toast.narrative} copy={PLAYER_COPY} /> : null}

      {wrongPopup && popupPos != null ? (
        <HintPopup
          popup={wrongPopup}
          hint={quest.display[popupPos].hint}
          skipCost={quest.skipCost}
          copy={PLAYER_COPY}
          on={{
            dismiss: () => runEvent({ type: 'dismiss_hint_offer' }),
            buy: () => runEvent({ type: 'buy_hint' }),
            // Переход вперёд очищает поле ответа в runEvent (effects.advanced).
            skip: () => runEvent({ type: 'skip_task' }),
          }}
        />
      ) : null}

      {revealedHint ? (
        <HintRevealPopup
          hint={{ text: revealedHint.text, image: revealedHint.image }}
          copy={PLAYER_COPY}
          on={{ dismiss: () => runEvent({ type: 'dismiss_hint_reveal' }) }}
        />
      ) : null}

      {overlay === 'menu' ? (
        <MenuOverlay
          copy={PLAYER_COPY}
          st={{ pos: pos + 1, total, coins, sound }}
          on={{
            close: () => setOverlay(null),
            sound: () => setSound((s) => !s),
            feedback: () => setOverlay('feedback'),
            exit: () => setOverlay('paused'),
            reset,
          }}
        />
      ) : null}

      {overlay === 'feedback' ? (
        <FeedbackSheet
          quest={{ title: quest.title }}
          copy={PLAYER_COPY}
          st={{ pos: pos + 1, stepName: display.title || display.template, text: feedbackText }}
          on={{
            dismiss: () => setOverlay('menu'),
            text: (e) => setFeedbackText(e.target.value),
            send: () => {
              runEvent({ type: 'feedback', note: feedbackText || 'Сообщение об ошибке' });
              setFeedbackText('');
              setOverlay(null);
            },
          }}
        />
      ) : null}

      {overlay === 'paused' ? (
        <TestPopup
          title="Тест на паузе"
          text={`Это тестовая попытка по черновику — шаг ${pos + 1} из ${total}. Прогресс не сохраняется.`}
          primary={{ label: 'Продолжить', on: () => setOverlay(null) }}
          ghost={{ label: 'Заново', on: reset }}
        />
      ) : null}

      {overlay === 'over' ? (
        <TestPopup
          title="Тест окончен"
          text="В опубликованном квесте здесь откроется каталог других квестов. Оценка и отзыв в тесте никуда не отправляются."
          primary={{ label: 'Заново', on: reset }}
          ghost={{ label: 'Вернуться к финалу', on: () => setOverlay(null) }}
        />
      ) : null}
    </PlayerFrame>
  );
}

export function TestOverlay({ quest, startPos, onClose }: {
  quest: CtorQuest;
  startPos: number;
  onClose: () => void;
}) {
  // Снапшот на момент запуска — правки черновика не дёргают идущий тест.
  const testQuest = useMemo<TestQuest>(() => {
    const snap = serializeDraft(quest);
    return {
      title: quest.meta.title,
      city: quest.meta.city || '—',
      duration: quest.meta.duration || '—',
      steps: snap.steps,
      display: snap.steps.map(toDesignStep),
      universalAnswer: snap.universal_answer,
      theme: snapshotTheme(snap),
      skipCost: snapshotSkipCost(snap),
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const total = testQuest.steps.length;
  const [runId, setRunId] = useState(0);
  const [from, setFrom] = useState(() => Math.max(0, Math.min(startPos, total - 1)));
  const [toast, setToast] = useState<string | null>(null);
  const calcScale = () =>
    typeof window === 'undefined'
      ? 0.95
      : Math.min(0.95, (window.innerHeight - 132) / 740, (window.innerWidth - 80) / 360);
  const [scale, setScale] = useState(calcScale);

  useEscape(onClose);
  useEffect(() => {
    const onResize = () => setScale(calcScale());
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const navToast = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), NAV_TOAST_MS);
  };

  return (
    <div className="wsp-test">
      <div className="wsp-test__bar">
        <span className="tag">ТЕСТ</span>
        <span className="inf">«{testQuest.title}» · черновик, снапшот на момент запуска · прогресс не сохраняется</span>
        <span className="sp" />
        <label className="inf" htmlFor="wsp-test-from">с шага</label>
        <select id="wsp-test-from" value={from} onChange={(e) => { setFrom(+e.target.value); setRunId((r) => r + 1); }}>
          {quest.steps.map((s, i) => (
            <option key={s.id} value={i}>{i + 1}. {s.name}</option>
          ))}
        </select>
        <button type="button" onClick={() => setRunId((r) => r + 1)}>⟲ Заново</button>
        <button type="button" onClick={onClose}>✕ Закрыть · Esc</button>
      </div>
      <div className="wsp-test__body">
        {total ? (
          <div className="wsp-testphone" style={{ width: 360 * scale, height: 740 * scale }}>
            <div style={{ transform: `scale(${scale})`, transformOrigin: '0 0', width: 360, height: 740 }}>
              <DraftRun key={`${runId}-${from}`} quest={testQuest} startPos={from} onNav={navToast} />
            </div>
          </div>
        ) : (
          <p className="inf" style={{ color: 'rgba(255,255,255,.65)' }}>В квесте нет страниц — нечего тестировать.</p>
        )}
      </div>
      {toast ? <div className="wsp-test__toast">{toast}</div> : null}
    </div>
  );
}
