'use client';

import React from 'react';
import type { BalanceNotice, AdvanceOffer, Fact } from '../../lib/shared-model';

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

export function PCompass({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 18 18" aria-hidden="true">
      <circle cx="9" cy="9" r="7.6" fill="none" stroke="currentColor" strokeWidth="1.6"></circle>
      <polygon points="9,4.5 11,9 9,13.5 7,9" fill="currentColor"></polygon>
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
  art?: 'paper';
  layout?: 'image' | 'text';
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
  acceptable?: string[] | null;
  action?: { desc?: string; confirmLabel?: string };
  nav?: { lat: number; lng: number; label?: string };
  gift?: { coins: number; narrative_text?: string };
  hint?: { cost?: number; text?: string } | string;
  allowNote?: boolean;
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
  navigator?: string;
  wrong1?: string;
  noteHolder?: string;
  /* Финал «Квест пройден!» — оценка необязательна, не блокирует «что дальше». */
  final?: string;
  whatNext?: string;
  /** Финал «пройти заново» — перезапуск этого же квеста с нуля. */
  playAgain?: string;
  skipRating?: string;
  rateLead?: string;
  rateThanks?: string;
  /* Пост-финальный каталог «Продолжите путешествие». */
  catalogKicker?: string;
  catalogTitle?: string;
  catalogLead?: string;
  catalogShare?: string;
  catalogHome?: string;
  catalogEmpty?: string;
  shareCopied?: string;
  menuTitle?: string;
  feedback?: string;
  exit?: string;
  reset?: string;
  sound?: string;
  online?: string;
  offline?: string;
  hintTitle?: string;
  hintBody?: (cost: number) => string;
  hintYes?: (cost: number) => string;
  hintNo?: string;
  giftToast?: (n: number) => string;
}

export interface StepState {
  answer?: string;
  note?: string;
  wrong?: boolean;
  hintRevealed?: boolean;
  coinsEarned?: number;
  time?: string;
  steps?: string;
  rating?: number;
  reviewSent?: boolean;
  allowNote?: boolean;
}

export interface StepHandlers {
  next?: () => void;
  confirm?: (note?: string) => void;
  submit?: (value: string) => void;
  answer?: (value: string) => void;
  note?: (e: React.ChangeEvent<HTMLTextAreaElement>) => void;
  buyHint?: () => void;
  play?: () => void;
  navigator?: () => void;
  rate?: (n: number) => void;
  /** Final screen «что дальше» — leave the finale (into the catalog). */
  onward?: () => void;
  /** Final screen «пройти заново» — replay this quest from step 0 (real player only). */
  replay?: () => void;
  review?: () => void;
}

/* Frame */
export function PlayerFrame({ children, screenLabel, tw = { art: "paper", layout: "image", anims: false } }: { children: React.ReactNode; screenLabel?: string; tw?: FrameTweaks }) {
  return (
    <div className="pframe" data-art={tw.art} data-layout={tw.layout} data-anims={tw.anims ? "on" : "off"} data-screen-label={screenLabel}>
      {children}
    </div>
  );
}

export function TopBar({ pos, total, coins, onMenu }: { pos: number; total: number; coins: number; onMenu?: () => void }) {
  return (
    <div className="p-top">
      <span className="p-top__progress">{pos} / {total}</span>
      <span className="p-top__right">
        <span className="p-coins"><PCoin />{coins}</span>
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
        <button className="p-media__play" type="button" aria-label="Смотреть видео" onClick={onPlay}>
          <span className="ic-ring"><PPlay /></span>
        </button>
        <span className="p-media__dur">{video.dur}</span>
      </div>
    );
  }
  if (image) {
    return <div className="p-media"><img src={image} alt="" /></div>;
  }
  return <div className="p-media p-media--ph"><span>{imageLabel || "комикс-иллюстрация"}</span></div>;
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
  const noop = () => {};

  if (step.template === "start") {
    return (
      <div className="p-stepbody">
        <p className="p-kicker">{step.kicker}</p>
        <h1 className="p-title">{step.title}</h1>
        <p className="p-kicker">{step.text}</p>
        <Flourish />
        <MediaBlock image={step.image} imageLabel={step.imageLabel} />
        <div className="p-meta">
          <span><PPin />{quest?.city || "Нови Сад"}</span>
          <span><PClock />{quest?.duration || "1.5 часа"}</span>
        </div>
        <div className="p-actions">
          <button className="p-btn p-btn--solid" onClick={h.next || noop}>{copy?.start || "начать квест"}</button>
        </div>
      </div>
    );
  }

  if (step.template === "video" || step.template === "route_video") {
    return (
      <div className="p-stepbody">
        <MediaBlock video={step.video} onPlay={h.play || noop} />
        <p className="p-text">{step.text}</p>
        <div className="p-actions">
          {step.nav && <button className="p-btn p-btn--ghost" onClick={h.navigator || noop}><PCompass />{copy?.navigator || "навигатор"}</button>}
          <button className="p-btn p-btn--solid" onClick={h.next || noop}>{step.template === "route_video" ? (copy?.onward || "в путь") : (copy?.next || "продолжить")}</button>
        </div>
      </div>
    );
  }

  if (step.template === "task_no") {
    return (
      <div className="p-stepbody">
        <MediaBlock image={step.image} imageLabel={step.imageLabel} />
        <p className="p-text">{step.text}</p>
        {step.place && <p className="p-place"><PPin />{step.place}</p>}
        {step.action && <p className="p-text" style={{ fontSize: "13.5px", color: "var(--p-muted)" }}>{step.action.desc}</p>}
        {step.allowNote || stateIn.allowNote ? (
          <textarea
            className="p-note"
            placeholder={copy?.noteHolder || "Заметка для себя (необязательно)"}
            value={stateIn.note || ""}
            onChange={(e) => h.note && h.note(e)}
          />
        ) : null}
        <div className="p-actions">
          {step.nav && <button className="p-btn p-btn--ghost" onClick={h.navigator || noop}><PCompass />Навигатор</button>}
          <button className="p-btn p-btn--solid" onClick={() => (h.confirm ? h.confirm() : (h.next || noop)())}>{step.action?.confirmLabel || "Я на месте"}</button>
        </div>
      </div>
    );
  }

  if (step.template === "task_answer") {
    const val = stateIn.answer || "";
    return (
      <div className="p-stepbody">
        <MediaBlock image={step.image} imageLabel={step.imageLabel} />
        <p className="p-text">{step.text}</p>
        {stateIn.hintRevealed ? (
          <div className="p-hintbox">
            <PCoin size={16} />
            <div><b>Подсказка</b> {typeof step.hint === 'string' ? step.hint : step.hint?.text}</div>
          </div>
        ) : null}
        {stateIn.wrong ? <p className="p-wrong"><PWarn />{copy?.wrong1 || "Неверно. Попробуйте ещё раз."}</p> : null}
        {/* Non-sticky bar: the input must scroll into view above the mobile
            keyboard, not stay pinned to the bottom of the dynamic viewport. */}
        <div className="p-actions p-actions--field">
          <input
            className={"p-input" + (stateIn.wrong ? " p-input--wrong" : "")}
            placeholder={step.prompt || "Введите ответ"}
            value={val}
            onChange={(e) => h.answer && h.answer(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && h.submit) h.submit(val); }}
          />
          <button className="p-btn p-btn--solid" type="button" onClick={() => h.submit && h.submit(val)}>{copy?.submit || "Ответить"}</button>
        </div>
      </div>
    );
  }

  if (step.template === "continue") {
    return (
      <div className="p-stepbody">
        <MediaBlock image={step.image} imageLabel={step.imageLabel} />
        <p className="p-text">{step.text}</p>
        <div className="p-actions">
          <button className="p-btn p-btn--solid" onClick={h.next || noop}>{copy?.next || "продолжить"}</button>
        </div>
      </div>
    );
  }

  if (step.template === "congrats") {
    // The final screen is its own component (optional, non-blocking rating +
    // «что дальше»); StepView delegates so the player, the constructor
    // test-player, and editor previews all render the one final implementation.
    return <FinalScreen quest={quest} copy={copy} st={stateIn} on={h} />;
  }

  return <div className="p-stepbody"><p>Шаг: {step.template}</p><button className="p-btn" onClick={h.next || noop}>Далее</button></div>;
}

export function RateStars({ value, onRate }: { value?: number; onRate?: (n: number) => void }) {
  return (
    <div className="p-rate">
      {[1, 2, 3, 4, 5].map((n) => (
        <button key={n} type="button" className={n <= (value || 0) ? "on" : ""} onClick={() => onRate && onRate(n)} aria-label={n + " звёзд"}>
          <PStar size={26} />
        </button>
      ))}
    </div>
  );
}

/* ============================================================
   FINAL — «Квест пройден!»
   Rating is OPTIONAL and never blocks: tapping a star records it and shows an
   inline thank-you; the forward action («что дальше») is always available and
   leads into the post-finale catalog. Replaces the old inline congrats branch —
   the single final-screen implementation, shared by the player, the constructor
   test-player and editor previews. Stats are coins + time only (resolved design
   decision; the «шагов» tile was dropped).
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
  // The forward action is always available (rating never blocks); «Пропустить
  // оценку» is just a quieter label for the same action while still unrated.
  const onward = h.onward || h.next || (() => {});
  // «пройти заново» is a real-player affordance (restart this quest from step 0).
  // It is gated on a wired handler so the constructor test-player and editor
  // previews — which pass none — never render a dead button.
  const replay = h.replay;

  return (
    <div className="p-stepbody p-final">
      <p className="p-kicker" style={{ marginTop: "6px" }}>{quest?.title || quest?.name}</p>
      <h2 className="p-title">{copy?.final || "Квест пройден!"}</h2>
      <Flourish />
      <div className="p-final-coins"><PCoin size={30} /><PCoin size={38} /><PCoin size={30} /></div>
      <div className="p-final-stats">
        <div className="p-stat"><b>{coins}</b><span>монет собрано</span></div>
        <div className="p-stat"><b>{s.time || "0:00"}</b><span>в пути</span></div>
      </div>

      <div className="p-ratecard">
        {rated ? (
          <>
            <RateStars value={s.rating} onRate={h.rate} />
            <span className="p-rate-thanks"><PCheck />{copy?.rateThanks || "Спасибо за оценку — отправим автору"}</span>
          </>
        ) : (
          <>
            <p className="lead">{copy?.rateLead || "Понравился квест? Оцените — это поможет автору. Можно пропустить."}</p>
            <RateStars value={s.rating} onRate={h.rate} />
          </>
        )}
      </div>

      <div className="p-actions">
        <button className="p-btn p-btn--solid" type="button" onClick={onward}>
          {copy?.whatNext || "что дальше"} <PArrow />
        </button>
        {replay && (
          <button className="p-btn p-btn--ghost" type="button" onClick={replay}>{copy?.playAgain || "пройти заново"}</button>
        )}
        {!rated && (
          <button className="p-skip" type="button" onClick={onward}>{copy?.skipRating || "Пропустить оценку"}</button>
        )}
      </div>
    </div>
  );
}

/** A quest card on the post-finale catalog. Rich meta (city/duration/rating/badge)
 *  is optional and renders only when present — the thin published list omits it. */
export interface CatalogCardView {
  id: string;
  title: string;
  mark: string;
  cover?: string | null;
  badge?: string;
  city?: string;
  duration?: string;
  rating?: string;
}

export interface CatalogHandlers {
  pick?: (id: string) => void;
  share?: () => void;
  home?: () => void;
}

/* ============================================================
   CATALOG — «Продолжите путешествие» (after the finale)
   The resolved post-finale invite: the finale is no longer a dead end — it offers
   the next quests to play, with share + home as soft exits.
   ============================================================ */
export function CatalogScreen({ quests, copy, on }: {
  quests: CatalogCardView[];
  copy?: StepCopy | null;
  on?: CatalogHandlers;
}) {
  const h = on || {};
  return (
    <div className="p-stepbody p-catalog">
      <div className="p-catalog__head">
        <p className="p-kicker">{copy?.catalogKicker || "маршрут окончен"}</p>
        <h2 className="p-title">{copy?.catalogTitle || "Продолжите путешествие"}</h2>
        <p className="p-text" style={{ fontSize: "13.5px", color: "var(--p-muted)", textAlign: "center" }}>
          {copy?.catalogLead || "Рядом — ещё истории этого города. Монеты переходят в ваш баланс."}
        </p>
      </div>

      {quests.length > 0 ? (
        <>
          {quests.map((q) => (
            <button key={q.id} className="q-card" type="button" onClick={() => h.pick && h.pick(q.id)}>
              <div className="q-card__cover">
                {q.badge && <span className="badge">{q.badge}</span>}
                {q.cover ? <img src={q.cover} alt="" /> : <span className="qmark">{q.mark}</span>}
              </div>
              <div className="q-card__body">
                <div className="q-card__title">{q.title}</div>
                {(q.city || q.duration || q.rating) && (
                  <div className="q-card__meta">
                    {q.city && <span><PPin size={12} />{q.city}</span>}
                    {q.duration && <span><PClock size={12} />{q.duration}</span>}
                    {q.rating && <span className="star">★ {q.rating}</span>}
                  </div>
                )}
                <span className="q-card__cta">{copy?.start || "начать квест"} <PArrow /></span>
              </div>
            </button>
          ))}
          <div className="p-catalog__sep">или</div>
        </>
      ) : (
        <p className="p-text" style={{ fontSize: "13.5px", color: "var(--p-muted)", textAlign: "center" }}>
          {copy?.catalogEmpty || "Скоро здесь появятся новые истории."}
        </p>
      )}

      <div className="p-catalog__foot">
        <button className="p-btn p-btn--ghost" type="button" onClick={h.share}>{copy?.catalogShare || "поделиться результатом"}</button>
        <button className="p-skip" type="button" onClick={h.home}>{copy?.catalogHome || "На главную"}</button>
      </div>
    </div>
  );
}

/* Баннер состояния синка — 3 состояния с точной копией из design/pwa/screens.jsx */
export function SyncBanner({ kind, count }: { kind: 'offline' | 'syncing' | 'done'; count?: number }) {
  if (kind === "offline") {
    return (
      <div className="p-syncbar">
        <span className="dot"></span>Офлайн. Прогресс сохраняется на устройстве
        {count ? <span className="cnt">{count} событий ждут</span> : null}
      </div>
    );
  }
  if (kind === "syncing") {
    return (
      <div className="p-syncbar p-syncbar--syncing">
        <span className="dot"></span>Онлайн. Отправляем события…
        {count ? <span className="cnt">осталось {count}</span> : null}
      </div>
    );
  }
  return <div className="p-syncbar p-syncbar--done"><span className="dot"></span>Прогресс синхронизирован</div>;
}

/* Человеческие подписи фактов для шторки «Синхронизация» */
const FACT_LABELS: Record<Fact['type'], string> = {
  physical_confirmed: 'Подтверждение на месте',
  answer_submitted: 'Ответ на задание',
  gift_claimed: 'Подарок за шаг',
  hint_purchased: 'Покупка подсказки',
  completion_bonus: 'Бонус за прохождение',
  attempt_completed: 'Квест пройден',
  feedback_reported: 'Сообщение об ошибке',
  navigator_used: 'Переход в навигатор',
  quest_rated: 'Оценка квеста',
};

/* Шторка «Синхронизация»: очередь событий с чипами ждёт/отправлено */
export function SyncSheet({ facts, isSent, online, onClose }: {
  facts: Fact[];
  isSent: (f: Fact) => boolean;
  online: boolean;
  onClose: () => void;
}) {
  return (
    <div className="p-menu">
      <div className="p-menu__head">
        <span className="p-menu__title">Синхронизация</span>
        <button className="p-iconbtn" type="button" aria-label="Закрыть" onClick={onClose}><PClose /></button>
      </div>
      <div className="p-menu__list">
        {facts.length === 0 && <p className="p-popup__text" style={{ padding: '14px 2px' }}>Пока нет событий — начните проходить квест.</p>}
        {facts.map((f, i) => (
          <div className="sync-row" key={i}>
            <div className="what">
              {FACT_LABELS[f.type]}
              <small>шаг {f.step_position + 1}{f.coins_delta ? ` · ${f.coins_delta > 0 ? '+' : ''}${f.coins_delta} монет` : ''}</small>
            </div>
            <span className={"sync-chip " + (isSent(f) ? "sync-chip--sent" : "sync-chip--wait")}>
              {isSent(f) ? "отправлено" : "ждёт отправки"}
            </span>
          </div>
        ))}
      </div>
      <span className={"p-offline-chip" + (online ? "" : " p-offline-chip--off")}>
        <span className="dot"></span>{online ? "Онлайн · события отправляются автоматически" : "Офлайн · события отправятся автоматически"}
      </span>
    </div>
  );
}

/* Коррекция 1 (SPEC): «Баланс обновлён» — old → new из diff проекций */
export function BalanceCorrectionPopup({ notice, onDismiss }: { notice: BalanceNotice; onDismiss: () => void }) {
  return (
    <div className="p-overlay" onClick={onDismiss}>
      <div className="p-popup" onClick={(e) => e.stopPropagation()}>
        <p className="p-popup__title"><PCoin size={20} />Баланс обновлён</p>
        <p className="p-popup__text">Пока вы были офлайн, на другом устройстве тоже шла игра. Мы объединили события — баланс пересчитан.</p>
        <div className="fix-balance">
          <span className="old">{notice.old}</span>
          <span className="arrow">→</span>
          <b><PCoin size={20} />{notice.new}</b>
        </div>
        <button className="p-btn" type="button" onClick={onDismiss}>Понятно</button>
      </div>
    </div>
  );
}

/* Коррекция 2 (SPEC): попытка продвинулась на другом устройстве.
   offer.*_step — индекс последнего ПРОЙДЕННОГО шага (0-based, -1 = ничего);
   текущий шаг для игрока = пройденный + 1, в подписи 1-based — отсюда +2. */
export function AdvanceOfferPopup({ offer, onAccept, onStay }: {
  offer: AdvanceOffer;
  onAccept: () => void;
  onStay: () => void;
}) {
  return (
    <div className="p-overlay" onClick={onStay}>
      <div className="p-popup" onClick={(e) => e.stopPropagation()}>
        <p className="p-popup__title">Попытка продвинулась</p>
        <p className="p-popup__text">На другом устройстве эта попытка ушла дальше. Шаги не теряются — события объединены.</p>
        <button className="p-btn" type="button" onClick={onAccept}>Продолжить с шага {offer.server_step + 2}</button>
        <button className="p-btn p-btn--ghost" type="button" onClick={onStay}>Остаться на шаге {offer.local_step + 2}</button>
      </div>
    </div>
  );
}

/* Overlays and toasts per design/player/components.jsx (lifted for full PWA flows) */
export function CoinToast({ amount, narrative, copy }: { amount: number; narrative?: string; copy?: StepCopy }) {
  return (
    <div className="p-toast" role="status">
      <PCoin size={22} />
      <span>{(copy && copy.giftToast ? copy.giftToast(amount) : `+${amount} монет`)}{narrative ? <small>{narrative}</small> : null}</span>
    </div>
  );
}

export function HintPopup({ step, copy, on }: {
  step: { hint?: { cost?: number; cost_coins?: number } };
  copy?: StepCopy | null;
  on?: { buy?: () => void; dismiss?: () => void };
}) {
  const h = on || {};
  const cost = step?.hint?.cost ?? step?.hint?.cost_coins ?? 5;
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

export interface MenuState {
  pos: number;
  total: number;
  coins: number;
  online: boolean;
  sound: boolean;
  pendingCount?: number;
}

export interface MenuHandlers {
  close?: () => void;
  feedback?: () => void;
  sync?: () => void;
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
        <button className="p-menu__item" type="button" onClick={h.sync}>Синхронизация<span className="spacer"></span><span className="val">{state.pendingCount ?? 0} событий</span></button>
        <button className="p-menu__item" type="button" onClick={h.exit}>{copy?.exit || "Выйти из квеста"}</button>
        <button className="p-menu__item p-menu__item--danger" type="button" onClick={h.reset}>{copy?.reset || "Сбросить прогресс"}</button>
      </div>
      <span className={"p-offline-chip" + (state.online ? "" : " p-offline-chip--off")}>
        <span className="dot"></span>{state.online ? (copy?.online || "Онлайн · прогресс синхронизирован") : (copy?.offline || "Офлайн · события сохраняются локально")}
      </span>
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

