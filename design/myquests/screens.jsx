// GEOHOD QUEST — «Мои квесты»: коллекция, попытки, загрузка бандла, профиль.
// Переиспользует SiteHeader/SCheckIcon из commerce/screens.jsx и стиль витрины.

const MQ_QUESTS = [
  {
    title: "Ирония Судьбы: по следам исторических личностей",
    city: "Нови Сад, Сербия", duration: "1.5 часа",
    photo: "assets/img/quest-card.png",
    state: "progress", pos: 5, total: 8, version: 3,
    dl: "ready", size: "4.8 МБ",
  },
  {
    title: "Тайна крепости",
    city: "Нови Сад, Сербия", duration: "2 часа",
    photo: null,
    state: "new", version: 1,
    dl: "none", size: "5.2 МБ", newVersion: false,
  },
  {
    title: "Чёрный барон",
    city: "Нови Сад, Сербия", duration: "1 час",
    photo: null,
    state: "done", rating: 5, version: 2,
    dl: "ready", size: "3.9 МБ", newVersion: true,
  },
];

function MqMeta({ q }) {
  return (
    <p className="mq-row__meta">
      <span><span className="ic" style={{ backgroundImage: "url('assets/icons/ic-pin--navy.svg')" }}></span>{q.city}</span>
      <span><span className="ic" style={{ backgroundImage: "url('assets/icons/ic-clock-ring--navy.svg')" }}></span>{q.duration}</span>
    </p>
  );
}

function MqPhoto({ q, className }) {
  return (
    <div className={className} style={q.photo ? { backgroundImage: `url('${q.photo}')` } : { background: "#1A2B48" }}>
      <span className="qmark">?</span>
    </div>
  );
}

function MqState({ q }) {
  if (q.state === "new") {
    return (
      <div className="mq-state">
        <span className="mq-badge mq-badge--new">Не начат</span>
        <span className="mq-sub">Куплен 11.06.2026 · доступ навсегда</span>
      </div>
    );
  }
  if (q.state === "progress") {
    return (
      <div className="mq-state">
        <span className="mq-badge mq-badge--progress">В процессе · шаг {q.pos} из {q.total}</span>
        <div className="mq-progressline"><i style={{ width: (q.pos / q.total) * 100 + "%" }}></i></div>
        <span className="mq-sub">Попытка от 09.06 · версия {q.version}</span>
      </div>
    );
  }
  return (
    <div className="mq-state">
      <span className="mq-badge mq-badge--done">Пройден</span>
      <span className="mq-stars">{[1,2,3,4,5].map((n) => <span key={n} className="st"></span>)}</span>
      <span className="mq-sub">Ваша оценка · 28.05.2026</span>
    </div>
  );
}

function MqDl({ q }) {
  if (q.dl === "ready") return <span className="mq-dl mq-dl--ready"><SCheckIcon size={12}></SCheckIcon>Скачан · работает офлайн ({q.size})</span>;
  return <span className="mq-dl">Не скачан · <button className="s-link" type="button">скачать для офлайна ({q.size})</button></span>;
}

function MqRow({ q }) {
  const action = q.state === "new" ? "Начать" : q.state === "progress" ? "Продолжить" : "Пройти заново";
  return (
    <div className="s-card mq-row">
      <MqPhoto q={q} className="mq-row__photo"></MqPhoto>
      <div className="mq-row__body">
        <MqMeta q={q}></MqMeta>
        <h3>{q.title}</h3>
        <MqDl q={q}></MqDl>
        {q.newVersion ? (
          <div className="mq-version">Вышла версия {q.version + 1}. Новая попытка начнётся на ней; завершённые остаются на своих версиях.</div>
        ) : null}
      </div>
      <MqState q={q}></MqState>
      <div className="mq-actions">
        <button className="s-btn" type="button">{action}</button>
        {q.state === "progress" ? <button className="s-btn s-btn--outline" type="button">Начать заново</button> : null}
      </div>
    </div>
  );
}

/* ---------- Desktop: список ---------- */
function MyQuestsPage() {
  return (
    <div className="site" style={{ width: "1240px", minHeight: "820px" }}>
      <SiteHeader></SiteHeader>
      <div className="co-wrap">
        <h2 className="co-title">Мои квесты</h2>
        <p className="co-sub">Все купленные и полученные квесты. Доступ бессрочный — проходите и возвращайтесь.</p>
        <div className="mq-list">
          {MQ_QUESTS.map((q, i) => <MqRow key={i} q={q}></MqRow>)}
        </div>
      </div>
    </div>
  );
}

function MyQuestsEmpty() {
  return (
    <div className="site" style={{ width: "1240px", minHeight: "640px" }}>
      <SiteHeader></SiteHeader>
      <div className="co-wrap">
        <h2 className="co-title">Мои квесты</h2>
        <div className="s-card mq-empty" style={{ marginTop: "24px" }}>
          <span className="ring">?</span>
          <h3>Пока ни одного квеста</h3>
          <p>Выберите квест в магазине — после покупки он навсегда появится здесь.</p>
          <button className="s-btn" type="button">В магазин квестов</button>
        </div>
      </div>
    </div>
  );
}

/* ---------- Desktop: профиль с монетами и рейтингом ---------- */
function ProfilePage() {
  return (
    <div className="site" style={{ width: "1240px", minHeight: "760px" }}>
      <SiteHeader></SiteHeader>
      <div className="co-wrap">
        <h2 className="co-title">Мой профиль</h2>
        <div className="pf-grid">
          <div className="s-card pf-card">
            <h4>Данные пользователя</h4>
            <div className="pf-row"><span className="lbl">Имя</span><span>Татьяна</span></div>
            <div className="pf-row"><span className="lbl">Telegram</span><span>@tatiana_ns</span></div>
            <div className="pf-row"><span className="lbl">Email</span><span>tatiana@gmail.com</span></div>
            <div className="co-divider"></div>
            <h4>Игровой счёт</h4>
            <div className="pf-tiles">
              <div className="pf-tile"><b><span className="pf-coin"></span>13</b><span>монет на балансе</span></div>
              <div className="pf-tile"><b>128</b><span>личный рейтинг</span></div>
              <div className="pf-tile"><b>2</b><span>квестов пройдено</span></div>
            </div>
            <p className="pf-note">Монеты начисляются за задания и финиш квеста, тратятся на подсказки. Рейтинг растёт с каждой накопленной монетой.</p>
          </div>
          <div className="s-card pf-card">
            <h4>Пройденные квесты</h4>
            {[{ t: "Чёрный барон", d: "28.05.2026" }, { t: "Тайна крепости", d: "14.04.2026" }].map((q, i) => (
              <div className="pf-row" key={i}>
                <span>{q.t}</span>
                <span className="mq-stars">{[1,2,3,4,5].map((n) => <span key={n} className="st"></span>)}</span>
              </div>
            ))}
            <button className="s-btn s-btn--outline" type="button">Все мои квесты</button>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ---------- Мобильные (360) ---------- */
function MobileShell({ children }) {
  return (
    <div className="site m-site">
      <div className="s-head">
        <button className="m-burger" type="button" aria-label="Меню"><span></span><span></span><span></span></button>
        <span className="s-logo"><span className="mark"></span><span className="text"></span></span>
        <span className="s-avatar" style={{ width: "36px", height: "36px" }}><span className="head"></span><span className="body"></span></span>
      </div>
      {children}
    </div>
  );
}

function MobileMyQuests() {
  const q = MQ_QUESTS[0];
  return (
    <MobileShell>
      <div className="sg-body">
        <h2 className="co-title" style={{ fontSize: "17px" }}>Мои квесты</h2>
        <div className="s-card mqm-card">
          <MqPhoto q={q} className="mqm-card__photo"></MqPhoto>
          <div className="mqm-card__body">
            <MqMeta q={q}></MqMeta>
            <h3>{q.title}</h3>
            <span className="mq-badge mq-badge--progress">В процессе · шаг {q.pos} из {q.total}</span>
            <div className="mq-progressline"><i style={{ width: "62%" }}></i></div>
            <span className="mq-dl mq-dl--ready"><SCheckIcon size={12}></SCheckIcon>Скачан · работает офлайн</span>
            <div className="mqm-card__foot">
              <span className="mq-sub">версия {q.version}</span>
              <button className="s-btn" type="button">Продолжить</button>
            </div>
          </div>
        </div>
      </div>
    </MobileShell>
  );
}

/* Старт-гейт владельца: продолжить / начать заново */
function StartGate() {
  const q = MQ_QUESTS[0];
  return (
    <MobileShell>
      <div className="sg-body">
        <MqPhoto q={q} className="sg-cover"></MqPhoto>
        <h2 className="co-title" style={{ fontSize: "17px" }}>{q.title}</h2>
        <div className="sg-attempt">
          <div className="co-row"><span className="lbl">Текущая попытка</span><span>от 09.06.2026</span></div>
          <div className="co-row"><span className="lbl">Прогресс</span><span>шаг {q.pos} из {q.total}</span></div>
          <div className="co-row"><span className="lbl">Версия квеста</span><span>{q.version}</span></div>
          <div className="mq-progressline"><i style={{ width: "62%" }}></i></div>
        </div>
        <button className="s-btn s-btn--block" type="button">Продолжить попытку</button>
        <button className="s-btn s-btn--outline s-btn--block" type="button">Начать заново</button>
        <p className="pf-note" style={{ textAlign: "center" }}>«Начать заново» сбросит прогресс попытки. Заработанные монеты останутся при вас.</p>
      </div>
    </MobileShell>
  );
}

/* Загрузка бандла: 3 состояния */
function BundleDownload({ stage }) {
  const q = MQ_QUESTS[0];
  return (
    <MobileShell>
      <div className="sg-body">
        <MqPhoto q={q} className="sg-cover"></MqPhoto>
        <h2 className="co-title" style={{ fontSize: "17px" }}>{q.title}</h2>
        {stage === "downloading" ? (
          <React.Fragment>
            <div className="sg-attempt">
              <span style={{ fontWeight: 600 }}>Скачиваем квест для офлайна…</span>
              <div className="dl-bar"><i style={{ width: "64%" }}></i></div>
              <div className="dl-status"><span>3,1 из 4,8 МБ</span><span>64%</span></div>
            </div>
            <p className="pf-note">Картинки, звуки и маршруты сохранятся на устройстве — квест будет работать без интернета.</p>
            <button className="s-btn" type="button" disabled>Начать квест</button>
          </React.Fragment>
        ) : null}
        {stage === "ready" ? (
          <React.Fragment>
            <div className="sg-attempt">
              <span className="dl-ready"><SCheckIcon size={15}></SCheckIcon>Квест скачан · работает офлайн</span>
              <div className="co-row"><span className="lbl">Размер</span><span>4,8 МБ</span></div>
              <div className="co-row"><span className="lbl">Версия</span><span>3 · от 02.05.2026</span></div>
            </div>
            <button className="s-btn s-btn--block" type="button">Начать квест</button>
          </React.Fragment>
        ) : null}
        {stage === "update" ? (
          <React.Fragment>
            <div className="sg-attempt">
              <span className="dl-ready"><SCheckIcon size={15}></SCheckIcon>Скачана версия 3</span>
              <div className="mq-version">Вышла версия 4 (5,1 МБ). Новая попытка начнётся на ней — скачайте обновление. Текущая попытка продолжится на версии 3 без скачивания.</div>
            </div>
            <button className="s-btn s-btn--block" type="button">Скачать версию 4</button>
            <button className="s-btn s-btn--outline s-btn--block" type="button">Продолжить на версии 3</button>
          </React.Fragment>
        ) : null}
      </div>
    </MobileShell>
  );
}

/* ---------- Играбельный прототип: скачать → старт-гейт → сброс ---------- */
function MyQuestsProto() {
  const q = MQ_QUESTS[0];
  const [stage, setStage] = React.useState("list");   // list | downloading | gate | confirm
  const [pct, setPct] = React.useState(0);
  const [hasAttempt, setHasAttempt] = React.useState(true);

  const startDownload = () => {
    setStage("downloading"); setPct(0);
    const t = setInterval(() => {
      setPct((p) => {
        if (p >= 100) { clearInterval(t); setStage("gate"); return 100; }
        return p + 4;
      });
    }, 90);
  };

  if (stage === "list") {
    return (
      <MobileShell>
        <div className="sg-body">
          <h2 className="co-title" style={{ fontSize: "17px" }}>Мои квесты</h2>
          <div className="s-card mqm-card">
            <MqPhoto q={q} className="mqm-card__photo"></MqPhoto>
            <div className="mqm-card__body">
              <h3>{q.title}</h3>
              {hasAttempt
                ? <span className="mq-badge mq-badge--progress">В процессе · шаг 5 из 8</span>
                : <span className="mq-badge mq-badge--new">Не начат</span>}
              <span className="mq-dl">Не скачан · 4,8 МБ</span>
              <div className="mqm-card__foot">
                <span className="mq-sub">версия 3</span>
                <button className="s-btn" type="button" onClick={startDownload}>Скачать</button>
              </div>
            </div>
          </div>
          <p className="pf-note">Прототип: «Скачать» покажет загрузку бандла, затем старт-гейт попытки.</p>
        </div>
      </MobileShell>
    );
  }
  if (stage === "downloading") {
    return (
      <MobileShell>
        <div className="sg-body">
          <MqPhoto q={q} className="sg-cover"></MqPhoto>
          <h2 className="co-title" style={{ fontSize: "17px" }}>{q.title}</h2>
          <div className="sg-attempt">
            <span style={{ fontWeight: 600 }}>Скачиваем квест для офлайна…</span>
            <div className="dl-bar"><i style={{ width: pct + "%" }}></i></div>
            <div className="dl-status"><span>{(4.8 * pct / 100).toFixed(1)} из 4,8 МБ</span><span>{pct}%</span></div>
          </div>
        </div>
      </MobileShell>
    );
  }
  return (
    <MobileShell>
      <div className="sg-body" style={{ position: "relative" }}>
        <MqPhoto q={q} className="sg-cover"></MqPhoto>
        <h2 className="co-title" style={{ fontSize: "17px" }}>{q.title}</h2>
        <div className="sg-attempt">
          <span className="dl-ready"><SCheckIcon size={15}></SCheckIcon>Скачан · работает офлайн</span>
          {hasAttempt ? (
            <React.Fragment>
              <div className="co-row"><span className="lbl">Попытка</span><span>шаг 5 из 8 · версия 3</span></div>
              <div className="mq-progressline"><i style={{ width: "62%" }}></i></div>
            </React.Fragment>
          ) : (
            <div className="co-row"><span className="lbl">Попыток нет</span><span>начните первую</span></div>
          )}
        </div>
        {hasAttempt ? (
          <React.Fragment>
            <button className="s-btn s-btn--block" type="button">Продолжить попытку</button>
            <button className="s-btn s-btn--outline s-btn--block" type="button" onClick={() => setStage("confirm")}>Начать заново</button>
          </React.Fragment>
        ) : (
          <button className="s-btn s-btn--block" type="button">Начать квест</button>
        )}
        <button className="s-link" type="button" onClick={() => { setStage("list"); setHasAttempt(true); }}>↺ в начало прототипа</button>
        {stage === "confirm" ? (
          <div style={{ position: "absolute", inset: "-8px -16px -20px", background: "rgba(35,35,35,.6)", display: "flex", alignItems: "center", justifyContent: "center", padding: "24px", zIndex: 5 }}>
            <div className="s-card" style={{ padding: "22px 20px", display: "flex", flexDirection: "column", gap: "12px", width: "100%" }}>
              <b style={{ fontSize: "15px" }}>Начать заново?</b>
              <p style={{ margin: 0, fontSize: "13px", color: "var(--gray)" }}>Прогресс попытки (шаг 5 из 8) сбросится. Монеты, заработанные ранее, останутся на балансе.</p>
              <button className="s-btn" type="button" onClick={() => { setHasAttempt(false); setStage("gate"); }}>Сбросить и начать</button>
              <button className="s-btn s-btn--outline" type="button" onClick={() => setStage("gate")}>Отмена</button>
            </div>
          </div>
        ) : null}
      </div>
    </MobileShell>
  );
}

Object.assign(window, {
  MyQuestsPage, MyQuestsEmpty, ProfilePage,
  MobileMyQuests, StartGate, BundleDownload, MyQuestsProto,
});
