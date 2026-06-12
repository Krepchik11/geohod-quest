// GEOHOD QUEST — компоненты плеера квеста (общие для канваса и прототипа).
// Экспортируются в window в конце файла.

/* ---------------- Иконки (только простые фигуры) ---------------- */
function PCoin({ size = 18 }) {
  return (
    <svg className="p-coin-svg" width={size} height={size} viewBox="0 0 20 20" aria-hidden="true">
      <circle cx="10" cy="10" r="9" fill="var(--p-coin)" stroke="var(--p-coin-rim)" strokeWidth="1.6"></circle>
      <circle cx="10" cy="10" r="5.4" fill="none" stroke="var(--p-coin-rim)" strokeWidth="1.2" opacity="0.8"></circle>
    </svg>
  );
}
function PPin({ size = 14 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden="true">
      <circle cx="8" cy="6" r="4.4" fill="none" stroke="currentColor" strokeWidth="1.6"></circle>
      <circle cx="8" cy="6" r="1.4" fill="currentColor"></circle>
      <polygon points="8,15.5 4.8,9.4 11.2,9.4" fill="currentColor"></polygon>
    </svg>
  );
}
function PClock({ size = 14 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden="true">
      <circle cx="8" cy="8" r="6.6" fill="none" stroke="currentColor" strokeWidth="1.6"></circle>
      <line x1="8" y1="8" x2="8" y2="4.6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"></line>
      <line x1="8" y1="8" x2="10.6" y2="9.4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"></line>
    </svg>
  );
}
function PCompass({ size = 16 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 18 18" aria-hidden="true">
      <circle cx="9" cy="9" r="7.6" fill="none" stroke="currentColor" strokeWidth="1.6"></circle>
      <polygon points="9,4.5 11,9 9,13.5 7,9" fill="currentColor"></polygon>
    </svg>
  );
}
function PBurger() {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true">
      <rect x="2" y="4" width="16" height="1.8" rx="0.9" fill="currentColor"></rect>
      <rect x="2" y="9.1" width="16" height="1.8" rx="0.9" fill="currentColor"></rect>
      <rect x="2" y="14.2" width="16" height="1.8" rx="0.9" fill="currentColor"></rect>
    </svg>
  );
}
function PClose() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
      <line x1="3" y1="3" x2="15" y2="15" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"></line>
      <line x1="15" y1="3" x2="3" y2="15" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"></line>
    </svg>
  );
}
function PPlay() {
  return (
    <svg width="22" height="22" viewBox="0 0 20 20" aria-hidden="true">
      <polygon points="6,3.5 17,10 6,16.5" fill="currentColor"></polygon>
    </svg>
  );
}
function PStar({ size = 30 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <polygon points="12,2.2 15,8.6 22,9.5 17,14.4 18.2,21.4 12,18 5.8,21.4 7,14.4 2,9.5 9,8.6" fill="currentColor"></polygon>
    </svg>
  );
}
function PCheck({ size = 14 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden="true">
      <polyline points="2.5,8.5 6.5,12.5 13.5,4" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"></polyline>
    </svg>
  );
}
function PWarn({ size = 14 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden="true">
      <circle cx="8" cy="8" r="7" fill="none" stroke="currentColor" strokeWidth="1.6"></circle>
      <line x1="8" y1="4.4" x2="8" y2="9" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"></line>
      <circle cx="8" cy="11.6" r="1" fill="currentColor"></circle>
    </svg>
  );
}

/* ---------------- Каркас экрана ---------------- */
function PlayerFrame({ tw, children, screenLabel }) {
  return (
    <div
      className="pframe"
      data-art={tw.art}
      data-layout={tw.layout}
      data-anims={tw.anims ? "on" : "off"}
      data-screen-label={screenLabel}
    >
      {children}
    </div>
  );
}

function TopBar({ pos, total, coins, onMenu }) {
  return (
    <div className="p-top">
      <span className="p-top__progress">{pos} / {total}</span>
      <span className="p-top__right">
        <span className="p-coins"><PCoin></PCoin>{coins}</span>
        <button className="p-iconbtn" type="button" aria-label="Меню" onClick={onMenu}><PBurger></PBurger></button>
      </span>
    </div>
  );
}

function Flourish() {
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

function MediaBlock({ image, imageLabel, video, onPlay }) {
  if (video) {
    return (
      <div className="p-media">
        {video.poster
          ? <img src={video.poster} alt=""></img>
          : <div className="p-media--ph" style={{ position: "absolute", inset: 0 }}><span>{video.label || "видео"}</span></div>}
        <button className="p-media__play" type="button" aria-label="Смотреть видео" onClick={onPlay}>
          <span className="ring"><PPlay></PPlay></span>
        </button>
        <span className="p-media__dur">{video.dur}</span>
      </div>
    );
  }
  if (image) {
    return <div className="p-media"><img src={image} alt=""></img></div>;
  }
  return <div className="p-media p-media--ph"><span>{imageLabel || "комикс-иллюстрация"}</span></div>;
}

/* ---------------- Рендер шага по шаблону ---------------- */
function StepView({ step, quest, copy, st, on }) {
  const state = st || {};
  const h = on || {};
  const noop = () => {};

  if (step.template === "start") {
    return (
      <div className="p-stepbody">
        <p className="p-kicker">{step.kicker}</p>
        <h1 className="p-title">{step.title}</h1>
        <p className="p-kicker">{step.text}</p>
        <Flourish></Flourish>
        <MediaBlock image={step.image} imageLabel={step.imageLabel}></MediaBlock>
        <div className="p-meta">
          <span><PPin></PPin>{quest.city}</span>
          <span><PClock></PClock>{quest.duration}</span>
        </div>
        <div className="p-actions">
          <button className="p-btn" type="button" onClick={h.next || noop}>{copy.start}</button>
        </div>
      </div>
    );
  }

  if (step.template === "video" || step.template === "route_video") {
    return (
      <div className="p-stepbody">
        <MediaBlock video={step.video} onPlay={h.play || noop}></MediaBlock>
        <p className="p-text">{step.text}</p>
        <div className="p-actions">
          {step.nav ? (
            <button className="p-btn p-btn--ghost" type="button" onClick={h.navigator || noop}>
              <PCompass></PCompass>{copy.navigator}
            </button>
          ) : null}
          <button className="p-btn" type="button" onClick={h.next || noop}>
            {step.template === "route_video" ? copy.onward : copy.next}
          </button>
        </div>
      </div>
    );
  }

  if (step.template === "task_no") {
    return (
      <div className="p-stepbody">
        <MediaBlock image={step.image} imageLabel={step.imageLabel}></MediaBlock>
        <p className="p-text">{step.text}</p>
        {step.place ? <p className="p-place"><PPin></PPin>{step.place}</p> : null}
        {step.action ? <p className="p-text" style={{ fontSize: "13.5px", color: "var(--p-muted)" }}>{step.action.desc}</p> : null}
        {step.allowNote ? (
          <textarea
            className="p-note"
            placeholder={copy.noteHolder}
            value={state.note || ""}
            onChange={h.note || noop}
          ></textarea>
        ) : null}
        <div className="p-actions">
          {step.nav ? (
            <button className="p-btn p-btn--ghost" type="button" onClick={h.navigator || noop}>
              <PCompass></PCompass>{copy.navigator}
            </button>
          ) : null}
          <button className="p-btn" type="button" onClick={h.confirm || noop}>
            {(step.action && step.action.confirmLabel) || "Выполнено"}
          </button>
        </div>
      </div>
    );
  }

  if (step.template === "task_answer") {
    return (
      <div className="p-stepbody">
        <MediaBlock image={step.image} imageLabel={step.imageLabel}></MediaBlock>
        <p className="p-text">{step.text}</p>
        {state.hintRevealed ? (
          <div className="p-hintbox">
            <PCoin size={16}></PCoin>
            <div><b>Подсказка</b>{step.hint.text}</div>
          </div>
        ) : null}
        {state.wrong ? <p className="p-wrong"><PWarn></PWarn>{copy.wrong1}</p> : null}
        <div className="p-actions">
          <input
            className={"p-input" + (state.wrong ? " p-input--wrong" : "")}
            placeholder={step.prompt}
            value={state.answer || ""}
            onChange={h.answer || noop}
            onKeyDown={(e) => { if (e.key === "Enter" && h.submit) h.submit(); }}
          ></input>
          <button className="p-btn" type="button" onClick={h.submit || noop}>{copy.submit}</button>
        </div>
      </div>
    );
  }

  if (step.template === "continue") {
    return (
      <div className="p-stepbody">
        <MediaBlock image={step.image} imageLabel={step.imageLabel}></MediaBlock>
        <p className="p-text">{step.text}</p>
        <div className="p-actions">
          <button className="p-btn" type="button" onClick={h.next || noop}>{copy.next}</button>
        </div>
      </div>
    );
  }

  // congrats — по умолчанию вариант B (целебрационный); A и C — отдельные компоненты ниже
  return <FinalB step={step} quest={quest} copy={copy} st={state} on={h}></FinalB>;
}

/* ---------------- Финал: три варианта ---------------- */
function RateStars({ value, onRate }) {
  return (
    <div className="p-rate">
      {[1, 2, 3, 4, 5].map((n) => (
        <button key={n} type="button" className={n <= (value || 0) ? "on" : ""} onClick={() => onRate && onRate(n)} aria-label={n + " звёзд"}>
          <PStar></PStar>
        </button>
      ))}
    </div>
  );
}

function Confetti() {
  const colors = ["#C99B3F", "#A33B2A", "#3E2C2C", "#E8A33A"];
  const bits = Array.from({ length: 18 }, (_, i) => ({
    left: (i * 53 + 17) % 100,
    delay: (i * 0.31) % 2.2,
    color: colors[i % colors.length],
    rot: (i * 47) % 90,
  }));
  return (
    <div className="p-confetti" aria-hidden="true">
      {bits.map((b, i) => (
        <i key={i} style={{ left: b.left + "%", animationDelay: b.delay + "s", background: b.color, transform: `rotate(${b.rot}deg)` }}></i>
      ))}
    </div>
  );
}

/* A — сдержанный: как «Продолжить» + бонус-тост + кнопка оценки */
function FinalA({ step, quest, copy, st, on }) {
  const h = on || {};
  return (
    <div className="p-stepbody">
      <MediaBlock image={step.image} imageLabel="комикс: финальная сцена"></MediaBlock>
      <h2 className="p-title" style={{ fontSize: "22px" }}>{step.title}</h2>
      <p className="p-text">{step.text}</p>
      <div className="p-actions">
        <button className="p-btn" type="button" onClick={h.review || (() => {})}>{copy.finalBtn}</button>
      </div>
    </div>
  );
}

/* B — целебрационный: итоги (монеты, время, шаги) + оценка на месте */
function FinalB({ step, quest, copy, st, on }) {
  const state = st || {}; const h = on || {};
  return (
    <div className="p-stepbody">
      <p className="p-kicker" style={{ marginTop: "6px" }}>{quest.title}</p>
      <h2 className="p-title">{step.title}</h2>
      <Flourish></Flourish>
      <div className="p-final-coins">
        <PCoin size={30}></PCoin><PCoin size={38}></PCoin><PCoin size={30}></PCoin>
      </div>
      <div className="p-final-stats">
        <div className="p-stat"><b>{state.coinsEarned != null ? state.coinsEarned : 13}</b><span>монет собрано</span></div>
        <div className="p-stat"><b>{state.time || "1:24"}</b><span>в пути</span></div>
        <div className="p-stat"><b>{state.steps || "8 / 8"}</b><span>шагов</span></div>
      </div>
      <p className="p-text" style={{ fontSize: "14px" }}>{step.text}</p>
      <div className="p-actions">
        {state.reviewSent
          ? <p className="p-kicker" style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: "8px" }}><PCheck></PCheck>{copy.finalDone}</p>
          : (
            <React.Fragment>
              <RateStars value={state.rating} onRate={h.rate}></RateStars>
              <button className="p-btn" type="button" onClick={h.review || (() => {})}>{copy.finalBtn}</button>
            </React.Fragment>
          )}
      </div>
    </div>
  );
}

/* C — полный: конфетти + крупная анимация монет + оценка + комментарий */
function FinalC({ step, quest, copy, st, on }) {
  const state = st || {}; const h = on || {};
  return (
    <div className="p-stepbody" style={{ position: "relative" }}>
      <Confetti></Confetti>
      <h2 className="p-title" style={{ marginTop: "10px" }}>{step.title}</h2>
      <p className="p-kicker">{quest.title} · {quest.city}</p>
      <div className="p-final-coins" style={{ margin: "8px 0" }}>
        <PCoin size={34}></PCoin><PCoin size={48}></PCoin><PCoin size={34}></PCoin>
      </div>
      <p className="p-title" style={{ fontSize: "20px" }}>+{(state.coinsEarned != null ? state.coinsEarned : 13)} монет</p>
      <Flourish></Flourish>
      <RateStars value={state.rating} onRate={h.rate}></RateStars>
      <textarea className="p-note" placeholder="Пара слов о квесте (необязательно)" value={state.comment || ""} onChange={h.comment || (() => {})}></textarea>
      <div className="p-actions">
        <button className="p-btn" type="button" onClick={h.review || (() => {})}>{copy.finalBtn}</button>
      </div>
    </div>
  );
}

/* ---------------- Оверлеи ---------------- */
function CoinToast({ amount, narrative, copy }) {
  return (
    <div className="p-toast" role="status">
      <PCoin size={22}></PCoin>
      <span>{copy.giftToast(amount)}{narrative ? <small>{narrative}</small> : null}</span>
    </div>
  );
}

function HintPopup({ step, balance, copy, on }) {
  const h = on || {};
  return (
    <div className="p-overlay" onClick={h.dismiss}>
      <div className="p-popup" onClick={(e) => e.stopPropagation()}>
        <p className="p-popup__title"><PCoin size={20}></PCoin>{copy.hintTitle}</p>
        <p className="p-popup__text">{copy.hintBody(step.hint.cost)}</p>
        <button className="p-btn" type="button" onClick={h.buy}>{copy.hintYes(step.hint.cost)}</button>
        <button className="p-btn p-btn--ghost" type="button" onClick={h.dismiss}>{copy.hintNo}</button>
      </div>
    </div>
  );
}

function MenuOverlay({ quest, copy, st, on }) {
  const state = st || {}; const h = on || {};
  return (
    <div className="p-menu">
      <div className="p-menu__head">
        <span className="p-menu__title">{copy.menuTitle}</span>
        <button className="p-iconbtn" type="button" aria-label="Закрыть" onClick={h.close}><PClose></PClose></button>
      </div>
      <div className="p-menu__stats">
        <div className="p-stat"><b>{state.pos} / {state.total}</b><span>шаг квеста</span></div>
        <div className="p-stat"><b style={{ display: "flex", alignItems: "center", gap: "6px" }}><PCoin size={15}></PCoin>{state.coins}</b><span>баланс монет</span></div>
      </div>
      <div className="p-progressline" style={{ margin: "4px 0 2px" }}><i style={{ width: (state.pos / state.total) * 100 + "%" }}></i></div>
      <div className="p-menu__list">
        <button className="p-menu__item" type="button" onClick={h.sound}>
          {copy.sound}<span className="spacer"></span><span className="val">{state.sound ? "вкл" : "выкл"}</span>
        </button>
        <button className="p-menu__item" type="button" onClick={h.feedback}><PWarn size={16}></PWarn>{copy.feedback}</button>
        <button className="p-menu__item" type="button" onClick={h.exit}>{copy.exit}</button>
        <button className="p-menu__item p-menu__item--danger" type="button" onClick={h.reset}>{copy.reset}</button>
      </div>
      <span className={"p-offline-chip" + (state.online ? "" : " p-offline-chip--off")}>
        <span className="dot"></span>{state.online ? copy.online : copy.offline}
      </span>
    </div>
  );
}

function FeedbackSheet({ quest, copy, st, on }) {
  const state = st || {}; const h = on || {};
  return (
    <div className="p-overlay" onClick={h.dismiss}>
      <div className="p-popup" onClick={(e) => e.stopPropagation()}>
        <p className="p-popup__title"><PWarn size={18}></PWarn>{copy.feedback}</p>
        <p className="p-ctx">Контекст приложится автоматически: «{quest.title}», шаг {state.pos} — {state.stepName}</p>
        <div className="p-form">
          <textarea placeholder="Что пошло не так? Опечатка, неверная подсказка, объект не найден…" value={state.text || ""} onChange={h.text || (() => {})}></textarea>
          <button className="p-btn" type="button" onClick={h.send}>Отправить</button>
        </div>
      </div>
    </div>
  );
}

function SyncBar({ copy }) {
  return <div className="p-syncbar"><span className="dot"></span>{copy.syncbar}</div>;
}

Object.assign(window, {
  PCoin, PPin, PClock, PCompass, PBurger, PClose, PPlay, PStar, PCheck, PWarn,
  PlayerFrame, TopBar, Flourish, MediaBlock, StepView,
  FinalA, FinalB, FinalC, RateStars, Confetti,
  CoinToast, HintPopup, MenuOverlay, FeedbackSheet, SyncBar,
});
