// GEOHOD QUEST — конструктор v2: тест-игрок.
// Играет ЧЕРНОВИК настоящими компонентами плеера и тем же isAnswerCorrect.
// Снапшот на момент запуска, прогресс эфемерный — как dry-run будущей версии.

function wspChime() {
  try {
    const ctx = wspChime.ctx || (wspChime.ctx = new (window.AudioContext || window.webkitAudioContext)());
    [987.77, 1318.5].forEach((f, i) => {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.type = "triangle"; o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, ctx.currentTime + i * 0.085);
      g.gain.exponentialRampToValueAtTime(0.12, ctx.currentTime + i * 0.085 + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + i * 0.085 + 0.35);
      o.connect(g).connect(ctx.destination);
      o.start(ctx.currentTime + i * 0.085); o.stop(ctx.currentTime + i * 0.085 + 0.4);
    });
  } catch (e) { /* без звука */ }
}

function WspTestPlayer({ pquest, copy, startPos, onNav }) {
  const total = pquest.steps.length;
  const clamp = (n) => Math.max(0, Math.min(n, total - 1));
  const [pos, setPos] = React.useState(clamp(startPos || 0));
  const [coins, setCoins] = React.useState(0);
  const [awarded, setAwarded] = React.useState([]);
  const [hints, setHints] = React.useState([]);
  const [wrongs, setWrongs] = React.useState({});
  const [sound, setSound] = React.useState(true);
  const [rating, setRating] = React.useState(0);
  const [reviewSent, setReviewSent] = React.useState(false);
  const [startTs] = React.useState(Date.now());
  const [answer, setAnswer] = React.useState("");
  const [note, setNote] = React.useState("");
  const [comment, setComment] = React.useState("");
  const [fbText, setFbText] = React.useState("");
  const [wrongFlash, setWrongFlash] = React.useState(false);
  const [toast, setToast] = React.useState(null);
  const [overlay, setOverlay] = React.useState(null);

  const step = pquest.steps[pos];

  const showToast = (amount, narrative) => {
    setToast({ amount, narrative });
    if (sound) wspChime();
    setTimeout(() => setToast(null), 1900);
  };

  const award = (s) => {
    if (!s.gift || awarded.includes(s.id)) return;
    setAwarded((a) => [...a, s.id]);
    setCoins((c) => c + s.gift.coins);
    showToast(s.gift.coins, s.gift.narrative);
  };

  // Бонус за прохождение — один раз, на входе в терминальный шаг (в т.ч. при старте теста с него)
  React.useEffect(() => {
    const s = pquest.steps[pos];
    if (s && s.template === "congrats" && !awarded.includes("__terminal")) {
      setAwarded((a) => [...a, "__terminal"]);
      setCoins((c) => c + pquest.completionBonus);
      setTimeout(() => showToast(pquest.completionBonus, "Бонус за прохождение"), 450);
    }
  }, [pos]);

  const goTo = (n) => { setAnswer(""); setNote(""); setWrongFlash(false); setPos(clamp(n)); };
  const next = () => { if (pos < total - 1) goTo(pos + 1); };

  const handlers = {
    next,
    play: () => {},
    navigator: () => {
      if (step.nav) onNav(`→ Системные карты: ${step.nav.label || "точка"} · ${step.nav.lat}, ${step.nav.lng}`);
    },
    note: (e) => setNote(e.target.value),
    answer: (e) => { setAnswer(e.target.value); setWrongFlash(false); },
    confirm: () => { award(step); setTimeout(next, step.gift ? 950 : 0); },
    submit: () => {
      if (!answer.trim()) return;
      const ok = window.isAnswerCorrect(answer, step.acceptable || []);
      if (ok) {
        award(step);
        setTimeout(next, step.gift ? 950 : 0);
      } else {
        const n = (wrongs[step.id] || 0) + 1;
        setWrongs((w) => ({ ...w, [step.id]: n }));
        if (n >= 2 && step.hint && !hints.includes(step.id)) setOverlay("hint");
        else setWrongFlash(true);
      }
    },
    rate: (n) => setRating(n),
    comment: (e) => setComment(e.target.value),
    review: () => setReviewSent(true),
  };

  const reset = () => {
    setPos(clamp(startPos || 0)); setCoins(0); setAwarded([]); setHints([]); setWrongs({});
    setRating(0); setReviewSent(false); setOverlay(null); setAnswer(""); setNote(""); setWrongFlash(false);
  };

  const menuHandlers = {
    close: () => setOverlay(null),
    sound: () => setSound((s) => !s),
    feedback: () => setOverlay("feedback"),
    exit: () => setOverlay("paused"),
    reset,
  };

  const elapsed = () => {
    const m = Math.max(1, Math.round((Date.now() - startTs) / 60000));
    return m >= 60 ? `${Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")}` : `0:${String(m).padStart(2, "0")}`;
  };

  const finalState = { coinsEarned: coins, time: elapsed(), steps: `${total} / ${total}`, rating, comment, reviewSent };
  const stepState = { answer, note, wrong: wrongFlash, hintRevealed: hints.includes(step.id), ...finalState };

  return (
    <PlayerFrame tw={{ art: "paper", layout: "image", anims: false }} screenLabel={"Тест: " + step.name}>
      {step.template !== "start" ? (
        <TopBar pos={pos + 1} total={total} coins={coins} onMenu={() => setOverlay("menu")}></TopBar>
      ) : null}

      {step.template === "congrats"
        ? <FinalB step={step} quest={pquest} copy={copy} st={finalState} on={handlers}></FinalB>
        : <StepView step={step} quest={pquest} copy={copy} st={stepState} on={handlers}></StepView>}

      {toast ? <CoinToast amount={toast.amount} narrative={toast.narrative} copy={copy}></CoinToast> : null}

      {overlay === "hint" ? (
        <HintPopup step={step} balance={coins} copy={copy} on={{
          dismiss: () => { setOverlay(null); setWrongFlash(true); },
          buy: () => { setCoins((c) => c - step.hint.cost); setHints((h) => [...h, step.id]); setOverlay(null); },
        }}></HintPopup>
      ) : null}

      {overlay === "menu" ? (
        <MenuOverlay quest={pquest} copy={copy}
          st={{ pos: pos + 1, total, coins, sound, online: true }} on={menuHandlers}></MenuOverlay>
      ) : null}

      {overlay === "feedback" ? (
        <FeedbackSheet quest={pquest} copy={copy}
          st={{ pos: pos + 1, stepName: step.name, text: fbText }}
          on={{
            dismiss: () => setOverlay("menu"),
            text: (e) => setFbText(e.target.value),
            send: () => { setFbText(""); setOverlay(null); },
          }}></FeedbackSheet>
      ) : null}

      {overlay === "paused" ? (
        <div className="p-overlay">
          <div className="p-popup">
            <p className="p-popup__title">Тест на паузе</p>
            <p className="p-popup__text">Это тестовая попытка по черновику — шаг {pos + 1} из {total}. Прогресс не сохраняется.</p>
            <button className="p-btn" type="button" onClick={() => setOverlay(null)}>Продолжить</button>
            <button className="p-btn p-btn--ghost" type="button" onClick={reset}>{copy.reset}</button>
          </div>
        </div>
      ) : null}
    </PlayerFrame>
  );
}

function TestOverlay({ quest, tone, startPos, onClose }) {
  const pquest = React.useMemo(() => wspSerialize(quest), []); // снапшот на момент запуска
  const [runId, setRunId] = React.useState(0);
  const [from, setFrom] = React.useState(Math.max(0, Math.min(startPos || 0, pquest.steps.length - 1)));
  const [toast, setToast] = React.useState(null);
  const calc = () => Math.min(0.95, (window.innerHeight - 132) / 740, (window.innerWidth - 80) / 360);
  const [scale, setScale] = React.useState(calc);

  React.useEffect(() => {
    const onResize = () => setScale(calc());
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("resize", onResize);
    window.addEventListener("keydown", onKey);
    return () => { window.removeEventListener("resize", onResize); window.removeEventListener("keydown", onKey); };
  }, []);

  const navToast = (msg) => {
    setToast(msg);
    setTimeout(() => setToast(null), 2600);
  };

  return (
    <div className="wsp-test" data-screen-label="Тест-игрок">
      <div className="wsp-test__bar">
        <span className="tag">ТЕСТ</span>
        <span className="inf">«{pquest.title}» · черновик, снапшот на момент запуска · прогресс не сохраняется</span>
        <span className="sp"></span>
        <label className="inf" htmlFor="wsp-test-from">с шага</label>
        <select id="wsp-test-from" value={from} onChange={(e) => { setFrom(+e.target.value); setRunId((r) => r + 1); }}>
          {pquest.steps.map((s, i) => (
            <option key={s.id} value={i}>{i + 1}. {s.name}</option>
          ))}
        </select>
        <button type="button" onClick={() => setRunId((r) => r + 1)}>⟲ Заново</button>
        <button type="button" onClick={onClose}>✕ Закрыть · Esc</button>
      </div>
      <div className="wsp-test__body">
        {pquest.steps.length ? (
          <div className="wsp-testphone" style={{ width: 360 * scale + "px", height: 740 * scale + "px" }}>
            <div style={{ transform: `scale(${scale})`, transformOrigin: "0 0", width: "360px", height: "740px" }}>
              <WspTestPlayer key={runId + "-" + from} pquest={pquest} copy={window.UI_COPY[tone] || window.UI_COPY.classic} startPos={from} onNav={navToast}></WspTestPlayer>
            </div>
          </div>
        ) : (
          <p className="inf" style={{ color: "rgba(255,255,255,.65)" }}>В квесте нет страниц — нечего тестировать.</p>
        )}
      </div>
      {toast ? <div className="wsp-test__toast">{toast}</div> : null}
    </div>
  );
}

Object.assign(window, { WspTestPlayer, TestOverlay });
