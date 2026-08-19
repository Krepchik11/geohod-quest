'use client';

import React, { useEffect, useRef, useState } from 'react';
import { plural } from '../../lib/ru';
import { themeVars, type QuestTheme } from '../../lib/quest-theme';

/**
 * Player components ported from design/player/components.jsx + canvas-screens + SPEC.
 * "Бумага" visual system. Used for:
 * - Live mini-previews in ctor picker/editor (as required by design)
 * - Main /quest player runtime
 * - PWA states
 *
 * Lifted structure/contracts/copy from design JSX (reference, not copy-paste of untyped).
 * All use the player theme CSS vars/classes added to globals.
 * isAnswerCorrect comes from shared-model (exact matcher parity enforced).
 */

export function PCoin({ size = 18 }: { size?: number }) {
  return (
    <svg className="p-coin-svg" width={size} height={size} viewBox="0 0 20 20" aria-hidden="true">
      <circle cx="10" cy="10" r="9" fill="var(--p-coin)" stroke="var(--p-coin-rim)" strokeWidth="1.6"></circle>
      <circle cx="10" cy="10" r="5.4" fill="none" stroke="var(--p-coin-rim)" strokeWidth="1.2" opacity="0.8"></circle>
    </svg>
  );
}

export function PPin({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden="true">
      <circle cx="8" cy="6" r="4.4" fill="none" stroke="currentColor" strokeWidth="1.6"></circle>
      <circle cx="8" cy="6" r="1.4" fill="currentColor"></circle>
      <polygon points="8,15.5 4.8,9.4 11.2,9.4" fill="currentColor"></polygon>
    </svg>
  );
}

export function PClock({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden="true">
      <circle cx="8" cy="8" r="6.6" fill="none" stroke="currentColor" strokeWidth="1.6"></circle>
      <line x1="8" y1="8" x2="8" y2="4.6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"></line>
      <line x1="8" y1="8" x2="10.6" y2="9.4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"></line>
    </svg>
  );
}

export function PBurger() {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true">
      <rect x="2" y="4" width="16" height="1.8" rx="0.9" fill="currentColor"></rect>
      <rect x="2" y="9.1" width="16" height="1.8" rx="0.9" fill="currentColor"></rect>
      <rect x="2" y="14.2" width="16" height="1.8" rx="0.9" fill="currentColor"></rect>
    </svg>
  );
}

export function PClose() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
      <line x1="3" y1="3" x2="15" y2="15" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"></line>
      <line x1="15" y1="3" x2="3" y2="15" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"></line>
    </svg>
  );
}

export function PPlay() {
  return (
    <svg width="22" height="22" viewBox="0 0 20 20" aria-hidden="true">
      <polygon points="6,3.5 17,10 6,16.5" fill="currentColor"></polygon>
    </svg>
  );
}

export function PStar({ size = 30 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <polygon points="12,2.2 15,8.6 22,9.5 17,14.4 18.2,21.4 12,18 5.8,21.4 7,14.4 2,9.5 9,8.6" fill="currentColor"></polygon>
    </svg>
  );
}

export function PCheck({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden="true">
      <polyline points="2.5,8.5 6.5,12.5 13.5,4" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"></polyline>
    </svg>
  );
}

export function PWarn({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden="true">
      <circle cx="8" cy="8" r="7" fill="none" stroke="currentColor" strokeWidth="1.6"></circle>
      <line x1="8" y1="4.4" x2="8" y2="9" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"></line>
      <circle cx="8" cy="11.6" r="1" fill="currentColor"></circle>
    </svg>
  );
}

export function PBack({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden="true">
      <polyline points="10,2.5 4.5,8 10,13.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"></polyline>
    </svg>
  );
}

export function PArrow() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" aria-hidden="true">
      <line x1="2" y1="8" x2="13" y2="8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"></line>
      <polyline points="8.5,3.5 13,8 8.5,12.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"></polyline>
    </svg>
  );
}

/* Design-shape contracts (lifted from design/player/components.jsx class contracts) */

export interface FrameTweaks {
  anims?: boolean;
}

export interface StepVideo {
  poster?: string;
  label?: string;
  dur?: string;
}

/** Display-shape of a step as the design StepView consumes it. */
export interface DesignStep {
  template: string;
  title?: string;
  kicker?: string;
  text?: string;
  image?: string | null;
  imageLabel?: string;
  video?: StepVideo;
  place?: string;
  prompt?: string | null;
  /** Author-set advance-button label (rich_content.button_text). */
  button?: string;
  acceptable?: string[] | null;
  action?: { desc?: string; confirmLabel?: string };
  nav?: { lat: number; lng: number; label?: string };
  gift?: { coins: number; narrative_text?: string };
  hint?: { cost?: number; text?: string; image?: string | null };
  completion?: { acceptable?: string[] | null };
}

export interface QuestMeta {
  title?: string;
  name?: string;
  city?: string;
  duration?: string;
  completionBonus?: number;
  stepsDone?: string | number;
}

/** RU copy bundle (UI_COPY shape from design/player/quest-data.js). */
export interface StepCopy {
  start?: string;
  next?: string;
  onward?: string;
  submit?: string;
  wrong1?: string;
  /* Финал (§11): «ОТПРАВИТЬ ОЦЕНКУ» активна при звёздах + отзыве; выход без
     отзыва — вторая кнопка (её ярлык зависит от того, выбраны ли звёзды). */
  final?: string;
  submitRating?: string;
  skipRating?: string;
  skipRated?: string;
  rateLead?: string;
  rateThanks?: string;
  /* Меню игрока. */
  menuTitle?: string;
  feedback?: string;
  exit?: string;
  reset?: string;
  sound?: string;
  hintTitle?: string;
  hintBody?: (cost: number) => string;
  hintYes?: (cost: number) => string;
  hintNo?: string;
  /** Заголовок и кнопка попапа с купленной подсказкой (текст и/или изображение). */
  hintRevealTitle?: string;
  hintOk?: string;
  giftToast?: (n: number) => string;
  /** Тост списания монет («−N монет» — покупка подсказки). */
  spendToast?: (n: number) => string;
}

export interface StepState {
  answer?: string;
  wrong?: boolean;
  hintRevealed?: boolean;
  /** §11: optional review text revealed after the star tap. */
  reviewText?: string;
  coinsEarned?: number;
  time?: string;
  steps?: string;
  rating?: number;
}

/**
 * Every control StepView can render, keyed by the handler that drives it.
 *
 * The contract: **a missing handler HIDES its control.** A control that renders
 * with a `noop` fallback is a button that lies — it looks tappable and does
 * nothing, with no type error and no runtime signal (exactly how the constructor
 * test-player shipped a dead «подсказка» chip). A surface that wants the controls
 * without the behavior — the editor previews — opts in explicitly with
 * `PREVIEW_HANDLERS`, never by omission.
 */
export interface StepHandlers {
  next?: () => void;
  confirm?: () => void;
  submit?: (value: string) => void;
  answer?: (value: string) => void;
  buyHint?: () => void;
  play?: () => void;
  navigator?: () => void;
  rate?: (n: number) => void;
  /** §11: review-text change (committed with the rating on «что дальше»). */
  reviewText?: (v: string) => void;
  /** Final screen exit — commit the rating and leave for the store. */
  onward?: () => void;
  /** Step back through history to reread earlier content (real player only). */
  back?: () => void;
}

const noop = () => {};

/**
 * The one sanctioned inert handler set (see `StepHandlers`): the constructor's
 * static previews render every control and do nothing *by explicit choice*.
 *
 * `Required<Omit<…>>` is load-bearing — adding a handler to `StepHandlers` without
 * listing it here is a compile error, so previews can never silently lose a control.
 * `back` is omitted: it is a real-player-only affordance whose
 * absence is itself the intended rendering.
 */
export const PREVIEW_HANDLERS: Required<Omit<StepHandlers, 'back'>> = {
  next: noop,
  confirm: noop,
  submit: noop,
  answer: noop,
  buyHint: noop,
  play: noop,
  navigator: noop,
  rate: noop,
  reviewText: noop,
  onward: noop,
};

/** The answer row: field + inline submit share ONE row, so the browser's native
 *  "scroll focused field into view" lifts BOTH above the on-screen keyboard (iOS,
 *  which ignores interactiveWidget, included). The <form> + enterKeyHint makes the
 *  keyboard's own action key («Отпр.») submit, and native form submission (unlike a
 *  manual Enter handler) respects IME composition — it never submits a half-composed
 *  value. The row floats to the step bottom via .p-actions' margin-top:auto (see
 *  player-paper.css). No handler → no form (see `StepHandlers`). */
function AnswerForm({ value, wrong, fieldLabel, submitLabel, onChange, onSubmit }: {
  value: string;
  wrong?: boolean;
  fieldLabel: string;
  submitLabel: string;
  onChange?: (v: string) => void;
  onSubmit?: (v: string) => void;
}) {
  if (!onSubmit) return null;
  const canSubmit = value.trim().length > 0;
  return (
    <form
      className="p-actions p-actions--field"
      onSubmit={(e) => {
        e.preventDefault();
        if (canSubmit) onSubmit(value);
      }}
    >
      <input
        className={"p-input" + (wrong ? " p-input--wrong" : "")}
        name="answer"
        placeholder="Введите ответ"
        value={value}
        onChange={(e) => onChange && onChange(e.target.value)}
        enterKeyHint="send"
        autoCapitalize="off"
        autoCorrect="off"
        autoComplete="off"
        spellCheck={false}
        aria-label={fieldLabel}
      />
      <button className="p-submit" type="submit" disabled={!canSubmit} aria-label={submitLabel}>
        <PArrow />
      </button>
    </form>
  );
}

/** The step's primary call to action. No handler → no button (see `StepHandlers`). */
function PrimaryAction({ on, label }: { on?: () => void; label: string }) {
  if (!on) return null;
  return (
    <div className="p-actions">
      <button className="p-btn p-btn--solid" onClick={on}>{label}</button>
    </div>
  );
}

/* Frame */
export function PlayerFrame({ children, screenLabel, tw = { anims: false }, theme }: {
  children: React.ReactNode;
  screenLabel?: string;
  tw?: FrameTweaks;
  /** Цвета квеста. Нет темы — плеер играется в бумажной палитре из CSS. */
  theme?: QuestTheme | null;
}) {
  return (
    <div
      className="pframe"
      data-anims={tw.anims ? "on" : "off"}
      data-screen-label={screenLabel}
      style={themeVars(theme)}
    >
      {children}
    </div>
  );
}

export function TopBar({ pos, total, coins, onMenu, onBack }: { pos: number; total: number; coins: number; onMenu?: () => void; onBack?: () => void }) {
  // The wallet chip reacts to every balance change: a bump + coin spin, tinted
  // by direction (gain gold / spend accent). Pure presentation — the number
  // itself always renders; the CSS animation is gated by the frame's anims flag
  // and prefers-reduced-motion (player-paper.css blanket rules).
  const prevCoins = useRef(coins);
  const [fx, setFx] = useState<'up' | 'down' | null>(null);
  useEffect(() => {
    if (coins === prevCoins.current) return;
    setFx(coins > prevCoins.current ? 'up' : 'down');
    prevCoins.current = coins;
    const t = setTimeout(() => setFx(null), 900);
    return () => clearTimeout(t);
  }, [coins]);
  return (
    <div className="p-top">
      <span className="p-top__left">
        {onBack && <button className="p-iconbtn" type="button" aria-label="Назад" onClick={onBack}><PBack /></button>}
        <span className="p-top__progress">{pos} / {total}</span>
      </span>
      <span className="p-top__right">
        <span className={'p-coins' + (fx ? ` p-coins--${fx}` : '')}><PCoin />{coins}</span>
        <button className="p-iconbtn" type="button" aria-label="Меню" onClick={onMenu}><PBurger /></button>
      </span>
    </div>
  );
}

export function Flourish() {
  return (
    <div className="p-flourish" aria-hidden="true">
      <i className="ln"></i>
      <svg width="34" height="10" viewBox="0 0 34 10">
        <circle cx="3" cy="5" r="1.4" fill="currentColor"></circle>
        <polygon points="17,0.5 21.5,5 17,9.5 12.5,5" fill="currentColor"></polygon>
        <circle cx="31" cy="5" r="1.4" fill="currentColor"></circle>
      </svg>
      <i className="ln"></i>
    </div>
  );
}

export function MediaBlock({ image, imageLabel, video, onPlay }: {
  image?: string | null;
  imageLabel?: string;
  video?: StepVideo;
  onPlay?: () => void;
}) {
  if (video) {
    return (
      <div className="p-media">
        {video.poster ? <img src={video.poster} alt="" /> : <div className="p-media--ph" style={{ position: "absolute", inset: 0 }}><span>{video.label || "видео"}</span></div>}
        {onPlay && (
          <button className="p-media__play" type="button" aria-label="Смотреть видео" onClick={onPlay}>
            <span className="ic-ring"><PPlay /></span>
          </button>
        )}
        <span className="p-media__dur">{video.dur}</span>
      </div>
    );
  }
  if (image) {
    return <div className="p-media"><img src={image} alt="" /></div>;
  }
  return <div className="p-media p-media--ph"><span>{imageLabel || "комикс-иллюстрация"}</span></div>;
}

/** Address line with the pin. When the step carries map coordinates (`nav`) the
 *  whole line is the map affordance — tapping it opens system maps (the old
 *  separate «навигатор» button is gone; the address itself is the button). */
export function PlaceLine({ place, nav, onOpen }: {
  place?: string;
  nav?: DesignStep['nav'];
  onOpen?: () => void;
}) {
  if (!place) return null;
  // No coordinates, or nothing wired to open them → a plain line, never a dead link.
  if (!nav || !onOpen) return <p className="p-place"><PPin />{place}</p>;
  return (
    <button className="p-place p-place--link" type="button" onClick={onOpen} aria-label={`Открыть в картах: ${place}`}>
      <PPin />{place}
    </button>
  );
}

/* Basic step renderer for 7 templates (lifted from design/player/components + screens) */
export function StepView({ step, quest, copy, st, on }: {
  step: DesignStep;
  quest?: QuestMeta;
  copy?: StepCopy;
  st?: StepState;
  on?: StepHandlers;
}) {
  const stateIn: StepState = st || {};
  const h: StepHandlers = on || {};

  if (step.template === "start") {
    return (
      <div className="p-stepbody">
        <p className="p-kicker">{step.kicker}</p>
        <h1 className="p-title">{step.title}</h1>
        <p className="p-kicker">{step.text}</p>
        <Flourish />
        <MediaBlock image={step.image} imageLabel={step.imageLabel} />
        {(quest?.city || quest?.duration) && (
          <div className="p-meta">
            {quest?.city && <span><PPin />{quest.city}</span>}
            {quest?.duration && <span><PClock />{quest.duration}</span>}
          </div>
        )}
        <PrimaryAction on={h.next} label={step.button || copy?.start || "начать квест"} />
      </div>
    );
  }

  if (step.template === "video" || step.template === "route_video") {
    return (
      <div className="p-stepbody">
        <MediaBlock video={step.video} onPlay={h.play} />
        <p className="p-text">{step.text}</p>
        <PlaceLine place={step.place} nav={step.nav} onOpen={h.navigator} />
        <PrimaryAction
          on={h.next}
          label={step.button || (step.template === "route_video" ? (copy?.onward || "в путь") : (copy?.next || "продолжить"))}
        />
      </div>
    );
  }

  if (step.template === "task_no") {
    return (
      <div className="p-stepbody">
        <MediaBlock image={step.image} imageLabel={step.imageLabel} />
        <p className="p-text">{step.text}</p>
        <PlaceLine place={step.place} nav={step.nav} onOpen={h.navigator} />
        {step.action && <p className="p-text" style={{ fontSize: "13.5px", color: "var(--p-muted)" }}>{step.action.desc}</p>}
        <PrimaryAction on={h.confirm} label={step.action?.confirmLabel || "Я на месте"} />
      </div>
    );
  }

  if (step.template === "task_answer") {
    const val = stateIn.answer || "";
    // The question lives ON THE PAGE: a placeholder disappears the moment the
    // player types, so a question stored there is unreadable mid-answer. The
    // legacy model default («Введите ответ», baked into old snapshots) is a
    // field hint, not a question — suppress it rather than echo the placeholder.
    const promptText = (step.prompt || "").trim();
    const question = promptText && promptText !== "Введите ответ" ? promptText : null;
    return (
      <div className="p-stepbody">
        <MediaBlock image={step.image} imageLabel={step.imageLabel} />
        <p className="p-text">{step.text}</p>
        <PlaceLine place={step.place} nav={step.nav} onOpen={h.navigator} />
        {question && <p className="p-prompt">{question}</p>}
        {stateIn.hintRevealed ? (
          <div className="p-hintbox">
            <PCoin size={16} />
            <div>
              <b>Подсказка</b>
              {step.hint?.text}
              {step.hint?.image ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img className="p-hintbox__img" src={step.hint.image} alt="Изображение-подсказка" />
              ) : null}
            </div>
          </div>
        ) : null}
        {stateIn.wrong ? <p className="p-wrong"><PWarn />{copy?.wrong1 || "Неверно. Попробуйте ещё раз."}</p> : null}
        {/* §8.1 (4.1): the hint is ALWAYS purchasable on steps that sell one —
            a paper chip above the answer form (the post-2nd-wrong popup stays as
            the proactive offer). Cost comes from the step data, never hardcoded.
            Disappears after purchase — the hint then renders inline above. */}
        {h.buyHint && step.hint && step.hint.cost != null && !stateIn.hintRevealed ? (
          <div className="p-hintchip-row">
            <button className="p-hintchip" type="button" onClick={h.buyHint}>
              <PCoin size={15} />
              подсказка · {step.hint.cost} {plural(step.hint.cost, 'монета', 'монеты', 'монет')}
            </button>
          </div>
        ) : null}
        <AnswerForm
          value={val}
          wrong={stateIn.wrong}
          fieldLabel={question || "Введите ответ"}
          submitLabel={copy?.submit || "Ответить"}
          onChange={h.answer}
          onSubmit={h.submit}
        />
      </div>
    );
  }

  if (step.template === "continue") {
    return (
      <div className="p-stepbody">
        <MediaBlock image={step.image} imageLabel={step.imageLabel} />
        <p className="p-text">{step.text}</p>
        <PrimaryAction on={h.next} label={step.button || copy?.next || "продолжить"} />
      </div>
    );
  }

  if (step.template === "congrats") {
    // The final screen is its own component (optional, non-blocking rating +
    // «что дальше»); StepView delegates so the player, the constructor
    // test-player, and editor previews all render the one final implementation.
    return <FinalScreen quest={quest} copy={copy} st={stateIn} on={h} />;
  }

  return (
    <div className="p-stepbody">
      <p>Шаг: {step.template}</p>
      {h.next && <button className="p-btn" onClick={h.next}>Далее</button>}
    </div>
  );
}

export function RateStars({ value, onRate }: { value?: number; onRate?: (n: number) => void }) {
  if (!onRate) return null;
  return (
    <div className="p-rate">
      {[1, 2, 3, 4, 5].map((n) => (
        <button key={n} type="button" className={n <= (value || 0) ? "on" : ""} onClick={() => onRate(n)} aria-label={n + " звёзд"}>
          <PStar size={26} />
        </button>
      ))}
    </div>
  );
}

/* ============================================================
   FINAL — «ПОЗДРАВЛЯЕМ ВЫ ПРОШЛИ КВЕСТ» (§11).
   The finale is the review funnel: «ОТПРАВИТЬ ОЦЕНКУ» unlocks only when the
   stars AND a review text are in; the second button is the exit for everyone
   else. BOTH actions commit-and-leave — a chosen star rating still commits on
   the exit path, which is why that button's label flips to «Отправить без
   отзыва» once stars are tapped.
   The single final-screen implementation, shared by the player, the
   constructor test-player and editor previews. Stats are coins + time only
   (resolved design decision; the «шагов» tile was dropped).
   ============================================================ */
export function FinalScreen({ quest, copy, st, on }: {
  quest?: QuestMeta;
  copy?: StepCopy | null;
  st?: StepState;
  on?: StepHandlers;
}) {
  const s = st || {};
  const h = on || {};
  const coins = s.coinsEarned != null ? s.coinsEarned : (quest?.completionBonus || 5);
  const rated = (s.rating || 0) > 0;
  const onward = h.onward;
  const canSubmit = rated && !!s.reviewText?.trim();

  return (
    <div className="p-stepbody p-final">
      {/* Chromeless by design (no TopBar) — the floating back button keeps
          "reread the last step" reachable here too. Previews pass no handler. */}
      {h.back && <button className="p-backfab" type="button" aria-label="Назад" onClick={h.back}><PBack /></button>}
      <p className="p-kicker" style={{ marginTop: "6px" }}>{quest?.title || quest?.name}</p>
      <h2 className="p-title">{copy?.final || "ПОЗДРАВЛЯЕМ ВЫ ПРОШЛИ КВЕСТ"}</h2>
      <Flourish />
      <div className="p-final-coins"><PCoin size={30} /><PCoin size={38} /><PCoin size={30} /></div>
      <div className="p-final-stats">
        <div className="p-stat"><b>{coins}</b><span>монет собрано</span></div>
        <div className="p-stat"><b>{s.time || "0:00"}</b><span>в пути</span></div>
      </div>

      <div className="p-ratecard">
        <p className="lead">{copy?.rateLead || "Оцените квест, оставьте отзыв и получите дополнительные коины"}</p>
        <RateStars value={s.rating} onRate={h.rate} />
        {rated && (
          <>
            <span className="p-rate-thanks"><PCheck />{copy?.rateThanks || "Спасибо за оценку — отправим автору"}</span>
            {/* §11: the review text — committed together with the rating. */}
            {h.reviewText && (
              <textarea
                className="p-reviewtext"
                placeholder="Пара слов для будущих игроков?"
                maxLength={500}
                value={s.reviewText || ''}
                onChange={(e) => h.reviewText!(e.target.value)}
              />
            )}
          </>
        )}
      </div>

      <div className="p-actions">
        {onward && (
          <button className="p-btn p-btn--solid" type="button" disabled={!canSubmit} onClick={onward}>
            {copy?.submitRating || "ОТПРАВИТЬ ОЦЕНКУ"} <PArrow />
          </button>
        )}
        {onward && !canSubmit && (
          <button className="p-btn p-btn--ghost" type="button" onClick={onward}>
            {rated
              ? (copy?.skipRated || "Отправить без отзыва")
              : (copy?.skipRating || "Пропустить оценку")}
          </button>
        )}
      </div>
    </div>
  );
}

/* Overlays and toasts per design/player/components.jsx (lifted for full PWA flows) */
/** Coin toast for BOTH directions: a positive amount is a gain («+N монет», coin
 *  spin), a negative one a spend («−N монет», reverse spin + accent tint). */
export function CoinToast({ amount, narrative, copy }: { amount: number; narrative?: string; copy?: StepCopy }) {
  const spend = amount < 0;
  const n = Math.abs(amount);
  const label = spend
    ? (copy?.spendToast ? copy.spendToast(n) : `−${n} монет`)
    : (copy?.giftToast ? copy.giftToast(n) : `+${n} монет`);
  return (
    <div className={'p-toast' + (spend ? ' p-toast--spend' : '')} role="status">
      <PCoin size={22} />
      <span>{label}{narrative ? <small>{narrative}</small> : null}</span>
    </div>
  );
}

export function HintPopup({ step, copy, on }: {
  step: { hint?: { cost?: number; cost_coins?: number } };
  copy?: StepCopy | null;
  on?: { buy?: () => void; dismiss?: () => void };
}) {
  const h = on || {};
  const cost = step?.hint?.cost ?? step?.hint?.cost_coins ?? 0;
  return (
    <div className="p-overlay" onClick={h.dismiss}>
      <div className="p-popup" onClick={(e) => e.stopPropagation()}>
        <p className="p-popup__title"><PCoin size={20} />{copy?.hintTitle || "Нужна подсказка?"}</p>
        <p className="p-popup__text">{copy && copy.hintBody ? copy.hintBody(cost) : `Обменяйте ${cost} монет на подсказку — она останется с вами до конца шага.`}</p>
        <button className="p-btn p-btn--solid" type="button" onClick={h.buy}>{copy && copy.hintYes ? copy.hintYes(cost) : `Потратить ${cost} монет`}</button>
        <button className="p-btn p-btn--ghost" type="button" onClick={h.dismiss}>{copy?.hintNo || "Попробую сам"}</button>
      </div>
    </div>
  );
}

/** The purchased hint itself, popup-sized: text, image, or both (SPEC hint flow).
 *  Shown right after the purchase; the inline hint box then keeps the content
 *  available for the rest of the step. */
export function HintRevealPopup({ hint, copy, on }: {
  hint: { text?: string; image?: string | null };
  copy?: StepCopy | null;
  on?: { dismiss?: () => void };
}) {
  const h = on || {};
  return (
    <div className="p-overlay" onClick={h.dismiss}>
      <div className="p-popup" onClick={(e) => e.stopPropagation()}>
        <p className="p-popup__title"><PCoin size={20} />{copy?.hintRevealTitle || "Подсказка"}</p>
        {hint.image ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img className="p-popup__img" src={hint.image} alt="Изображение-подсказка" />
        ) : null}
        {hint.text ? <p className="p-popup__text">{hint.text}</p> : null}
        <button className="p-btn p-btn--solid" type="button" onClick={h.dismiss}>{copy?.hintOk || "Понятно"}</button>
      </div>
    </div>
  );
}

export interface MenuState {
  pos: number;
  total: number;
  /** The global coin wallet (== top bar == profile). */
  coins: number;
  sound: boolean;
}

export interface MenuHandlers {
  close?: () => void;
  feedback?: () => void;
  exit?: () => void;
  reset?: () => void;
  sound?: () => void;
}

export function MenuOverlay({ copy, st, on }: {
  quest?: QuestMeta;
  copy?: StepCopy | null;
  st: MenuState;
  on?: MenuHandlers;
}) {
  const state = st; const h = on || {};
  return (
    <div className="p-menu">
      <div className="p-menu__head">
        <span className="p-menu__title">{copy?.menuTitle || "Меню квеста"}</span>
        <button className="p-iconbtn" type="button" aria-label="Закрыть" onClick={h.close}><PClose /></button>
      </div>
      <div className="p-menu__stats">
        <div className="p-stat"><b>{state.pos} / {state.total}</b><span>шаг квеста</span></div>
        <div className="p-stat"><b style={{ display: "flex", alignItems: "center", gap: "6px" }}><PCoin size={15} />{state.coins}</b><span>баланс монет</span></div>
      </div>
      <div className="p-progressline" style={{ margin: "4px 0 2px" }}><i style={{ width: (state.pos / state.total) * 100 + "%" }}></i></div>
      <div className="p-menu__list">
        <button className="p-menu__item" type="button" onClick={h.sound}>{copy?.sound || "Звук"}<span className="spacer"></span><span className="val">{state.sound ? "вкл" : "выкл"}</span></button>
        <button className="p-menu__item" type="button" onClick={h.feedback}><PWarn size={16} />{copy?.feedback || "Сообщить об ошибке"}</button>
        <button className="p-menu__item" type="button" onClick={h.exit}>{copy?.exit || "Выйти из квеста"}</button>
        <button className="p-menu__item p-menu__item--danger" type="button" onClick={h.reset}>{copy?.reset || "Сбросить прогресс"}</button>
      </div>
    </div>
  );
}

export function FeedbackSheet({ quest, copy, st, on }: {
  quest?: QuestMeta;
  copy?: StepCopy | null;
  st: { pos: number; stepName?: string; text?: string };
  on?: { dismiss?: () => void; text?: (e: React.ChangeEvent<HTMLTextAreaElement>) => void; send?: () => void };
}) {
  const state = st; const h = on || {};
  return (
    <div className="p-overlay" onClick={h.dismiss}>
      <div className="p-popup" onClick={(e) => e.stopPropagation()}>
        <p className="p-popup__title"><PWarn size={18} />{copy?.feedback || "Сообщить об ошибке"}</p>
        <p className="p-ctx">Контекст приложится автоматически: «{quest?.title || quest?.name}», шаг {state.pos} — {state.stepName}</p>
        <div className="p-form">
          <textarea placeholder="Что пошло не так? Опечатка, неверная подсказка, объект не найден…" value={state.text || ""} onChange={h.text || (() => {})}></textarea>
          <button className="p-btn" type="button" onClick={h.send}>Отправить</button>
        </div>
      </div>
    </div>
  );
}

