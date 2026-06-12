// GEOHOD QUEST — PWA-синк: состояния соединения, очередь фактов, коррекции.
// Использует компоненты плеера; факты — человеческим языком, без техжаргона.

const PWA_TW = { art: "paper", layout: "image", anims: true, tone: "classic" };
// Статичные артборды рендерятся без entrance-анимаций: видимость контента
// не должна зависеть от проигрывания анимации (скриншоты, экспорт, заморозка).
const PWA_TW_STATIC = { art: "paper", layout: "image", anims: false, tone: "classic" };

function SyncBanner({ kind, count }) {
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
  return (
    <div className="p-syncbar p-syncbar--done">
      <span className="dot"></span>Прогресс синхронизирован
    </div>
  );
}

function PwaShot({ overlay, banner, st, idx = 4, coins = 8, label }) {
  const quest = window.QUEST_DEMO;
  const step = quest.steps[idx];
  const copy = window.UI_COPY.classic;
  return (
    <PlayerFrame tw={PWA_TW_STATIC} screenLabel={label}>
      <TopBar pos={idx + 1} total={quest.steps.length} coins={coins}></TopBar>
      {banner}
      <StepView step={step} quest={quest} copy={copy} st={st}></StepView>
      {overlay}
    </PlayerFrame>
  );
}

/* --- Состояния соединения --- */
function BoardOfflineQueue() {
  return <PwaShot label="Офлайн · события копятся локально" banner={<SyncBanner kind="offline" count={6}></SyncBanner>}></PwaShot>;
}
function BoardSyncing() {
  return <PwaShot label="Возврат онлайн · отправка событий" banner={<SyncBanner kind="syncing" count={4}></SyncBanner>}></PwaShot>;
}
function BoardSynced() {
  return <PwaShot label="Синхронизировано" banner={<SyncBanner kind="done"></SyncBanner>}></PwaShot>;
}

/* --- Шторка «Синхронизация» (из меню) --- */
function BoardSyncSheet() {
  const rows = [
    { what: "Шаг 4 пройден", sub: "«Задание без ответа 1» · 14:02", st: "wait" },
    { what: "+3 монеты за задание", sub: "14:02", st: "wait" },
    { what: "Подсказка куплена (−5 монет)", sub: "«Задание с ответом 1» · 14:11", st: "wait" },
    { what: "Шаг 5 пройден", sub: "14:14", st: "wait" },
    { what: "+5 монет за задание", sub: "14:14", st: "wait" },
    { what: "Отзыв об ошибке", sub: "шаг 5 · 14:16", st: "wait" },
    { what: "Шаг 3 пройден", sub: "вчера, 19:40", st: "sent" },
  ];
  return (
    <PlayerFrame tw={PWA_TW_STATIC} screenLabel="Шторка: очередь синхронизации">
      <div className="p-menu">
        <div className="p-menu__head">
          <span className="p-menu__title">Синхронизация</span>
          <button className="p-iconbtn" type="button" aria-label="Закрыть"><PClose></PClose></button>
        </div>
        <div style={{ overflow: "hidden", flex: 1, marginTop: "6px" }}>
          {rows.map((r, i) => (
            <div className="sync-row" key={i}>
              <span className="what">{r.what}<small>{r.sub}</small></span>
              <span className={"sync-chip sync-chip--" + r.st}>{r.st === "wait" ? "ждёт отправки" : "отправлено"}</span>
            </div>
          ))}
        </div>
        <span className="p-offline-chip p-offline-chip--off">
          <span className="dot"></span>Офлайн · события отправятся автоматически
        </span>
      </div>
    </PlayerFrame>
  );
}

/* --- Коррекции --- */
function BoardFixBalance() {
  const overlay = (
    <div className="p-overlay">
      <div className="p-popup">
        <p className="p-popup__title"><PCoin size={20}></PCoin>Баланс обновлён</p>
        <p className="p-popup__text">Пока вы были офлайн, на другом устройстве потратились монеты. Сервер свёл все события воедино:</p>
        <div className="fix-balance">
          <span className="old">13</span><span className="arrow">→</span><b><PCoin size={20}></PCoin>8</b>
        </div>
        <button className="p-btn" type="button">Понятно</button>
      </div>
    </div>
  );
  return <PwaShot label="Коррекция: баланс скорректирован" coins={8} overlay={overlay}></PwaShot>;
}

function BoardFixDevice() {
  const overlay = (
    <div className="p-overlay">
      <div className="p-popup">
        <p className="p-popup__title">Попытка продвинулась</p>
        <p className="p-popup__text">На другом устройстве эта попытка дошла до шага 7 из 8. Продолжим оттуда — пройденные шаги не теряются.</p>
        <button className="p-btn" type="button">Продолжить с шага 7</button>
        <button className="p-btn p-btn--ghost" type="button">Остаться на шаге 5 (только посмотреть)</button>
      </div>
    </div>
  );
  return <PwaShot label="Мультидевайс: попытка ушла вперёд" overlay={overlay}></PwaShot>;
}

/* --- Играбельная симуляция --- */
function PwaProto() {
  const quest = window.QUEST_DEMO;
  const copy = window.UI_COPY.classic;
  const [online, setOnline] = React.useState(true);
  const [queue, setQueue] = React.useState([]);     // {what}
  const [coins, setCoins] = React.useState(13);
  const [banner, setBanner] = React.useState(null); // offline | syncing | done
  const [fix, setFix] = React.useState(false);
  const [n, setN] = React.useState(0);

  const addFact = (what, dCoins) => {
    if (dCoins) setCoins((c) => c + dCoins);
    if (online) return; // онлайн — «улетает сразу»
    setQueue((q) => [...q, { what }]);
  };

  const goOffline = () => { setOnline(false); setBanner("offline"); };
  const goOnline = () => {
    setOnline(true);
    if (!queue.length) { setBanner("done"); setTimeout(() => setBanner(null), 1800); return; }
    setBanner("syncing");
    let left = queue.length;
    const t = setInterval(() => {
      left -= 1;
      setQueue((q) => q.slice(1));
      if (left <= 0) {
        clearInterval(t);
        setBanner("done");
        // демо-коррекция: сервер знает о трате на другом устройстве
        setTimeout(() => { setCoins(8); setFix(true); }, 700);
        setTimeout(() => setBanner(null), 1800);
      }
    }, 550);
  };

  const step = quest.steps[4];
  return (
    <div style={{ display: "flex", gap: "20px", alignItems: "flex-start" }}>
      <PlayerFrame tw={PWA_TW} screenLabel="Симуляция синка">
        <TopBar pos={5} total={quest.steps.length} coins={coins}></TopBar>
        {banner === "offline" ? <SyncBanner kind="offline" count={queue.length}></SyncBanner> : null}
        {banner === "syncing" ? <SyncBanner kind="syncing" count={queue.length}></SyncBanner> : null}
        {banner === "done" ? <SyncBanner kind="done"></SyncBanner> : null}
        <StepView step={step} quest={quest} copy={copy} st={{}}></StepView>
        {fix ? (
          <div className="p-overlay" onClick={() => setFix(false)}>
            <div className="p-popup" onClick={(e) => e.stopPropagation()}>
              <p className="p-popup__title"><PCoin size={20}></PCoin>Баланс обновлён</p>
              <p className="p-popup__text">Сервер свёл события всех устройств: трата на втором телефоне учтена.</p>
              <div className="fix-balance"><span className="old">13</span><span className="arrow">→</span><b><PCoin size={20}></PCoin>8</b></div>
              <button className="p-btn" type="button" onClick={() => setFix(false)}>Понятно</button>
            </div>
          </div>
        ) : null}
      </PlayerFrame>

      <div className="sim-panel">
        <b>Пульт симуляции</b>
        <div className="row">
          {online
            ? <button className="sim-btn sim-btn--primary" type="button" onClick={goOffline}>✈ Уйти в офлайн</button>
            : <button className="sim-btn sim-btn--primary" type="button" onClick={goOnline}>⇡ Вернуться онлайн</button>}
        </div>
        <div className="row">
          <button className="sim-btn" type="button" onClick={() => { setN(n + 1); addFact("Шаг пройден"); }}>Пройти шаг</button>
          <button className="sim-btn" type="button" onClick={() => addFact("+3 монеты", 3)}>Получить +3 монеты</button>
          <button className="sim-btn" type="button" onClick={() => addFact("Подсказка −5", -5)}>Купить подсказку −5</button>
        </div>
        <span className="sim-note">
          {online
            ? "Онлайн: события уходят на сервер сразу."
            : `Офлайн: событий в очереди — ${queue.length}. Вернитесь онлайн, чтобы увидеть отправку и коррекцию баланса (демо: на «другом устройстве» потратили 5 монет).`}
        </span>
      </div>
    </div>
  );
}

Object.assign(window, {
  BoardOfflineQueue, BoardSyncing, BoardSynced, BoardSyncSheet,
  BoardFixBalance, BoardFixDevice, PwaProto,
});
