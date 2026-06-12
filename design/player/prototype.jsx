// GEOHOD QUEST — играбельный прототип плеера.
// Полный сквозной флоу: монеты, подсказки, навигатор, меню, офлайн, финал.
// Позиция и факты сохраняются в localStorage (ключ geohod-player-proto-v1).

const PROTO_KEY = "geohod-player-proto-v1";

function loadProto() {
  try { return JSON.parse(localStorage.getItem(PROTO_KEY)) || {}; } catch (e) { return {}; }
}
function saveProto(s) {
  const { pos, coins, awarded, hints, wrongs, rating, reviewSent, startTs, sound } = s;
  localStorage.setItem(PROTO_KEY, JSON.stringify({ pos, coins, awarded, hints, wrongs, rating, reviewSent, startTs, sound }));
}

/* Звук монеты — синтез WebAudio, без ассетов */
function coinChime() {
  try {
    const ctx = coinChime.ctx || (coinChime.ctx = new (window.AudioContext || window.webkitAudioContext)());
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

function PlayerApp({ tw }) {
  const quest = window.QUEST_DEMO;
  const copy = window.UI_COPY[tw.tone];
  const saved = React.useMemo(loadProto, []);

  const [pos, setPos] = React.useState(saved.pos || 0);
  const [coins, setCoins] = React.useState(saved.coins || 0);
  const [awarded, setAwarded] = React.useState(saved.awarded || []);   // id шагов с начисленным подарком
  const [hints, setHints] = React.useState(saved.hints || []);         // id шагов с купленной подсказкой
  const [wrongs, setWrongs] = React.useState(saved.wrongs || {});      // id → число неверных
  const [sound, setSound] = React.useState(saved.sound !== false);
  const [rating, setRating] = React.useState(saved.rating || 0);
  const [reviewSent, setReviewSent] = React.useState(saved.reviewSent || false);
  const [startTs] = React.useState(saved.startTs || Date.now());

  const [answer, setAnswer] = React.useState("");
  const [note, setNote] = React.useState("");
  const [comment, setComment] = React.useState("");
  const [fbText, setFbText] = React.useState("");
  const [wrongFlash, setWrongFlash] = React.useState(false);
  const [toast, setToast] = React.useState(null);                      // {amount, narrative}
  const [overlay, setOverlay] = React.useState(null);                  // hint | menu | feedback | paused | null
  const [online, setOnline] = React.useState(navigator.onLine);

  React.useEffect(() => {
    const on = () => setOnline(true), off = () => setOnline(false);
    window.addEventListener("online", on); window.addEventListener("offline", off);
    return () => { window.removeEventListener("online", on); window.removeEventListener("offline", off); };
  }, []);

  React.useEffect(() => {
    saveProto({ pos, coins, awarded, hints, wrongs, rating, reviewSent, startTs, sound });
  }, [pos, coins, awarded, hints, wrongs, rating, reviewSent, startTs, sound]);

  const step = quest.steps[pos];
  const total = quest.steps.length;

  const showToast = (amount, narrative) => {
    setToast({ amount, narrative });
    if (sound) coinChime();
    setTimeout(() => setToast(null), 1900);
  };

  const award = (s) => {
    if (!s.gift || awarded.includes(s.id)) return;
    setAwarded((a) => [...a, s.id]);
    setCoins((c) => c + s.gift.coins);
    showToast(s.gift.coins, s.gift.narrative);
  };

  const goTo = (n) => {
    setAnswer(""); setNote(""); setWrongFlash(false);
    const target = quest.steps[n];
    setPos(n);
    // Бонус за прохождение — один раз, на входе в терминальный шаг
    if (target && target.template === "congrats" && !awarded.includes("__terminal")) {
      setAwarded((a) => [...a, "__terminal"]);
      setCoins((c) => c + quest.completionBonus);
      setTimeout(() => showToast(quest.completionBonus, "Бонус за прохождение"), 450);
    }
  };
  const next = () => { if (pos < total - 1) goTo(pos + 1); };

  const handlers = {
    next,
    play: () => {},
    navigator: () => {
      if (step.nav) window.open(`https://maps.google.com/?q=${step.nav.lat},${step.nav.lng}`, "_blank");
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

  const menuHandlers = {
    close: () => setOverlay(null),
    sound: () => setSound((s) => !s),
    feedback: () => setOverlay("feedback"),
    exit: () => setOverlay("paused"),
    reset: () => {
      localStorage.removeItem(PROTO_KEY);
      setPos(0); setCoins(0); setAwarded([]); setHints([]); setWrongs({});
      setRating(0); setReviewSent(false); setOverlay(null); setAnswer(""); setNote("");
    },
  };

  const elapsed = () => {
    const m = Math.max(1, Math.round((Date.now() - startTs) / 60000));
    return m >= 60 ? `${Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")}` : `0:${String(m).padStart(2, "0")}`;
  };

  const finalState = {
    coinsEarned: coins, time: elapsed(), steps: `${total} / ${total}`,
    rating, comment, reviewSent,
  };

  const stepState = {
    answer, note,
    wrong: wrongFlash,
    hintRevealed: hints.includes(step.id),
    ...finalState,
  };

  const FinalCmp = tw.final === "A" ? FinalA : tw.final === "C" ? FinalC : FinalB;

  return (
    <PlayerFrame tw={tw} screenLabel={"Прототип: " + step.name}>
      {step.template !== "start" ? (
        <TopBar pos={pos + 1} total={total} coins={coins} onMenu={() => setOverlay("menu")}></TopBar>
      ) : null}
      {!online && step.template !== "start" ? <SyncBar copy={copy}></SyncBar> : null}

      {step.template === "congrats"
        ? <FinalCmp step={step} quest={quest} copy={copy} st={finalState} on={handlers}></FinalCmp>
        : <StepView step={step} quest={quest} copy={copy} st={stepState} on={handlers}></StepView>}

      {toast ? <CoinToast amount={toast.amount} narrative={toast.narrative} copy={copy}></CoinToast> : null}

      {overlay === "hint" ? (
        <HintPopup step={step} balance={coins} copy={copy} on={{
          dismiss: () => { setOverlay(null); setWrongFlash(true); },
          buy: () => { setCoins((c) => c - step.hint.cost); setHints((h) => [...h, step.id]); setOverlay(null); },
        }}></HintPopup>
      ) : null}

      {overlay === "menu" ? (
        <MenuOverlay quest={quest} copy={copy}
          st={{ pos: pos + 1, total, coins, sound, online }} on={menuHandlers}></MenuOverlay>
      ) : null}

      {overlay === "feedback" ? (
        <FeedbackSheet quest={quest} copy={copy}
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
            <p className="p-popup__title">Квест на паузе</p>
            <p className="p-popup__text">Прогресс сохранён — шаг {pos + 1} из {total}. Вернуться можно в любой момент, попытка останется за вами.</p>
            <button className="p-btn" type="button" onClick={() => setOverlay(null)}>Продолжить</button>
            <button className="p-btn p-btn--ghost" type="button" onClick={menuHandlers.reset}>{copy.reset}</button>
          </div>
        </div>
      ) : null}
    </PlayerFrame>
  );
}

Object.assign(window, { PlayerApp });
