'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { serializeDraft, type CtorQuest } from '../../lib/constructor-model';
import { toDesignStep } from '../../lib/design-step';
import { isAnswerCorrect } from '../../lib/shared-model';
import { PLAYER_COPY } from '../../lib/player-copy';
import {
  CoinToast,
  FeedbackSheet,
  HintPopup,
  MenuOverlay,
  PlayerFrame,
  StepView,
  TopBar,
  type DesignStep,
} from '../player/PlayerComponents';
import { coinChime } from '../quest/sound';

/**
 * Тест-игрок конструктора: играет ЧЕРНОВИК настоящими компонентами плеера и
 * тем же isAnswerCorrect. Снапшот берётся на момент запуска, прогресс
 * эфемерный — dry-run будущей версии (design/ctor2/test-player.jsx).
 */

const COMPLETION_BONUS = 5;
const TOAST_MS = 1900;
const NAV_TOAST_MS = 2600;

interface TestQuest {
  title: string;
  city: string;
  duration: string;
  steps: DesignStep[];
}

function DraftRun({ quest, startPos, onNav }: { quest: TestQuest; startPos: number; onNav: (msg: string) => void }) {
  const total = quest.steps.length;
  const clamp = (n: number) => Math.max(0, Math.min(n, total - 1));
  // Старт прямо с «Поздравления» сразу даёт терминальный бонус (как в дизайне).
  const startsAtFinal = quest.steps[clamp(startPos)].template === 'congrats';
  const [pos, setPos] = useState(() => clamp(startPos));
  const [coins, setCoins] = useState(() => (startsAtFinal ? COMPLETION_BONUS : 0));
  const [awarded, setAwarded] = useState<string[]>(() => (startsAtFinal ? ['__terminal'] : []));
  const [hints, setHints] = useState<number[]>([]);
  const [wrongs, setWrongs] = useState<Record<number, number>>({});
  const [sound, setSound] = useState(true);
  const [rating, setRating] = useState(0);
  const [reviewSent, setReviewSent] = useState(false);
  const [startTs, setStartTs] = useState(() => Date.now());
  const [finalTime, setFinalTime] = useState('0:01');
  const [answer, setAnswer] = useState('');
  const [note, setNote] = useState('');
  const [feedbackText, setFeedbackText] = useState('');
  const [wrongFlash, setWrongFlash] = useState(false);
  const [toast, setToast] = useState<{ amount: number; narrative?: string } | null>(null);
  const [overlay, setOverlay] = useState<'hint' | 'menu' | 'feedback' | 'paused' | null>(null);
  const timers = useRef<Array<ReturnType<typeof setTimeout>>>([]);
  useEffect(() => {
    const pending = timers.current;
    return () => pending.forEach(clearTimeout);
  }, []);
  const after = (ms: number, fn: () => void) => timers.current.push(setTimeout(fn, ms));

  const step = quest.steps[pos];

  const showToast = (amount: number, narrative?: string) => {
    setToast({ amount, narrative });
    if (sound) coinChime();
    after(TOAST_MS, () => setToast(null));
  };

  // Тост стартового бонуса — асинхронно после маунта (сам бонус уже в стейте).
  useEffect(() => {
    if (startsAtFinal) after(450, () => showToast(COMPLETION_BONUS, 'Бонус за прохождение'));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const awardKey = (i: number) => `step-${i}`;
  const award = (s: DesignStep, i: number) => {
    if (!s.gift || awarded.includes(awardKey(i))) return false;
    setAwarded((a) => [...a, awardKey(i)]);
    setCoins((c) => c + s.gift!.coins);
    showToast(s.gift.coins, s.gift.narrative_text);
    return true;
  };

  const elapsed = () => {
    const m = Math.max(1, Math.round((Date.now() - startTs) / 60000));
    return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`;
  };

  /** Бонус за прохождение — один раз, при входе в терминальный шаг (событие, не эффект). */
  const goTo = (n: number) => {
    const target = clamp(n);
    setAnswer('');
    setNote('');
    setWrongFlash(false);
    setPos(target);
    if (quest.steps[target].template === 'congrats' && !awarded.includes('__terminal')) {
      setAwarded((a) => [...a, '__terminal']);
      setCoins((c) => c + COMPLETION_BONUS);
      setFinalTime(elapsed());
      after(450, () => showToast(COMPLETION_BONUS, 'Бонус за прохождение'));
    }
  };
  const next = () => { if (pos < total - 1) goTo(pos + 1); };

  const reset = () => {
    setPos(clamp(startPos));
    setCoins(startsAtFinal ? COMPLETION_BONUS : 0);
    setAwarded(startsAtFinal ? ['__terminal'] : []);
    setHints([]);
    setWrongs({});
    setRating(0);
    setReviewSent(false);
    setOverlay(null);
    setAnswer('');
    setNote('');
    setWrongFlash(false);
    setStartTs(Date.now());
    setFinalTime('0:01');
  };

  const handlers = {
    next,
    play: () => {},
    navigator: () => {
      if (step.nav) onNav(`→ Системные карты: ${step.nav.label || 'точка'} · ${step.nav.lat}, ${step.nav.lng}`);
    },
    note: (e: React.ChangeEvent<HTMLTextAreaElement>) => setNote(e.target.value),
    answer: (value: string) => { setAnswer(value); setWrongFlash(false); },
    confirm: () => {
      const gifted = award(step, pos);
      if (gifted) after(950, next);
      else next();
    },
    submit: (value: string) => {
      if (!value.trim()) return;
      if (isAnswerCorrect(value, step.acceptable || [])) {
        const gifted = award(step, pos);
        if (gifted) after(950, next);
        else next();
      } else {
        const n = (wrongs[pos] || 0) + 1;
        setWrongs((w) => ({ ...w, [pos]: n }));
        if (n >= 2 && step.hint && !hints.includes(pos)) setOverlay('hint');
        else setWrongFlash(true);
      }
    },
    rate: (n: number) => setRating(n),
    review: () => setReviewSent(true),
  };

  const hintCost = typeof step.hint === 'object' && step.hint ? step.hint.cost || 0 : 0;
  const stepState = {
    answer,
    note,
    wrong: wrongFlash,
    hintRevealed: hints.includes(pos),
    coinsEarned: coins,
    time: finalTime,
    steps: `${total} / ${total}`,
    rating,
    reviewSent,
  };

  return (
    <PlayerFrame tw={{ art: 'paper', layout: 'image', anims: false }} screenLabel={'Тест: ' + (step.title || step.template)}>
      {step.template !== 'start' ? (
        <TopBar pos={pos + 1} total={total} coins={coins} onMenu={() => setOverlay('menu')} />
      ) : null}

      <StepView
        step={step}
        quest={{ title: quest.title, city: quest.city, duration: quest.duration, completionBonus: COMPLETION_BONUS }}
        copy={PLAYER_COPY}
        st={stepState}
        on={handlers}
      />

      {toast ? <CoinToast amount={toast.amount} narrative={toast.narrative} copy={PLAYER_COPY} /> : null}

      {overlay === 'hint' ? (
        <HintPopup
          step={{ hint: { cost: hintCost } }}
          copy={PLAYER_COPY}
          on={{
            dismiss: () => { setOverlay(null); setWrongFlash(true); },
            buy: () => { setCoins((c) => c - hintCost); setHints((h) => [...h, pos]); setOverlay(null); },
          }}
        />
      ) : null}

      {overlay === 'menu' ? (
        <MenuOverlay
          copy={PLAYER_COPY}
          st={{ pos: pos + 1, total, coins, sound, online: true, pendingCount: 0 }}
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
          st={{ pos: pos + 1, stepName: step.title || step.template, text: feedbackText }}
          on={{
            dismiss: () => setOverlay('menu'),
            text: (e) => setFeedbackText(e.target.value),
            send: () => { setFeedbackText(''); setOverlay(null); },
          }}
        />
      ) : null}

      {overlay === 'paused' ? (
        <div className="p-overlay">
          <div className="p-popup">
            <p className="p-popup__title">Тест на паузе</p>
            <p className="p-popup__text">Это тестовая попытка по черновику — шаг {pos + 1} из {total}. Прогресс не сохраняется.</p>
            <button className="p-btn" type="button" onClick={() => setOverlay(null)}>Продолжить</button>
            <button className="p-btn p-btn--ghost" type="button" onClick={reset}>Заново</button>
          </div>
        </div>
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
      steps: snap.steps.map(toDesignStep),
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

  useEffect(() => {
    const onResize = () => setScale(calcScale());
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('resize', onResize);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('resize', onResize);
      window.removeEventListener('keydown', onKey);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
