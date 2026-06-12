// GEOHOD QUEST — конструктор v2: шапка workspace, список квестов, создание.

function WspHeader({ crumbs, children }) {
  return (
    <header className="wsp-top">
      <span className="brand"></span>
      <span className="wsp-crumbs">{crumbs}</span>
      <span className="sp"></span>
      {children}
    </header>
  );
}

function WspQuestRow({ quest, onOpen }) {
  const gates = wspGates(quest);
  const live = quest.versions.find((v) => v.live);
  const m = quest.meta;
  const metaLine = [m.city, m.duration, (m.price > 0 ? m.price + " ₽" : "бесплатно")].filter(Boolean).join(" · ");
  const errN = gates.errors.length;
  return (
    <div className="wsp-qrow" onClick={onOpen}>
      {m.cover
        ? <img className="cover" src={m.cover} alt=""></img>
        : <span className="cover-ph">нет обложки</span>}
      <span className="body">
        <span className="ttl">{m.title}</span>
        <div className="meta">{metaLine}</div>
      </span>
      <span className="chips">
        <span className="wsp-chip mut">черновик · {quest.steps.length} {wspPlural(quest.steps.length, "страница", "страницы", "страниц")}</span>
        {errN ? <span className="wsp-chip err">{errN} {wspPlural(errN, "ошибка", "ошибки", "ошибок")} гейтов</span> : null}
        {live
          ? <span className="wsp-chip live">v{live.n} в магазине</span>
          : <span className="wsp-chip draft">не опубликован</span>}
      </span>
      <button className="adm-btn adm-btn--outline adm-btn--sm" type="button">Открыть</button>
    </div>
  );
}

function CreateQuestModal({ onClose, onCreate }) {
  const [m, setM] = React.useState({ title: "", city: "", duration: "", price: "", desc: "", cover: null });
  const set = (p) => setM({ ...m, ...p });
  return (
    <div className="wsp-ovl" onClick={onClose}>
      <div className="adm-modal" style={{ width: "640px" }} onClick={(e) => e.stopPropagation()}>
        <h3>Новый квест</h3>
        <div>
          <label className="adm-label">Название<small>видно игроку на первом экране и в магазине</small></label>
          <input autoFocus className="adm-input" value={m.title} onChange={(e) => set({ title: e.target.value })}></input>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: "12px" }}>
          <div>
            <label className="adm-label">Город</label>
            <input className="adm-input" placeholder="Нови Сад" value={m.city} onChange={(e) => set({ city: e.target.value })}></input>
          </div>
          <div>
            <label className="adm-label">Длительность</label>
            <input className="adm-input" placeholder="2–3 часа" value={m.duration} onChange={(e) => set({ duration: e.target.value })}></input>
          </div>
          <div>
            <label className="adm-label">Цена, ₽</label>
            <input className="adm-input" type="number" min="0" placeholder="0" value={m.price} onChange={(e) => set({ price: e.target.value })}></input>
          </div>
        </div>
        <div>
          <label className="adm-label">Описание для магазина</label>
          <textarea className="adm-textarea" placeholder="Пара абзацев: о чём квест, что увидит игрок" value={m.desc} onChange={(e) => set({ desc: e.target.value })}></textarea>
        </div>
        <div>
          <label className="adm-label">Обложка</label>
          <div className={"comic-zone" + (m.cover ? " filled" : "")} style={{ width: "220px" }} onClick={() => set({ cover: m.cover ? null : WSP_DEMO_IMG.cover })}>
            {m.cover
              ? <React.Fragment><img src={m.cover} alt=""></img><span className="tag">обложка</span></React.Fragment>
              : <React.Fragment><b>обложка</b>PNG/JPG · прототип: клик ставит демо-файл</React.Fragment>}
          </div>
        </div>
        <p className="note">Квест создастся с двумя обязательными страницами — «Первый экран» и «Поздравление». Цена 0 ₽ — бесплатный квест; оплата, купоны и выдача доступов живут в магазине.</p>
        <div className="row">
          <button className="adm-btn adm-btn--outline" type="button" onClick={onClose}>Отмена</button>
          <button className="adm-btn" type="button" disabled={!m.title.trim()} onClick={() => onCreate({ ...m, price: +m.price || 0 })}>Создать квест</button>
        </div>
      </div>
    </div>
  );
}

function QuestListScreen({ quests, onOpen, onCreate }) {
  const [modal, setModal] = React.useState(false);
  return (
    <React.Fragment>
      <WspHeader crumbs={<b>Конструктор квестов</b>}>
        <button className="adm-btn" type="button" onClick={() => setModal(true)}>+ Новый квест</button>
      </WspHeader>
      <div className="wsp-list" data-screen-label="Список квестов">
        <div className="wsp-listhead">
          <h2>Квесты</h2>
          <span className="cnt">{quests.length} {wspPlural(quests.length, "квест", "квеста", "квестов")}</span>
        </div>
        {quests.map((q) => (
          <WspQuestRow key={q.id} quest={q} onOpen={() => onOpen(q.id)}></WspQuestRow>
        ))}
        {!quests.length ? (
          <div className="wsp-empty">
            <span>Квестов пока нет. Создайте первый — он сразу получит «Первый экран» и «Поздравление».</span>
            <button className="adm-btn" type="button" onClick={() => setModal(true)}>+ Новый квест</button>
          </div>
        ) : null}
      </div>
      {modal ? (
        <CreateQuestModal
          onClose={() => setModal(false)}
          onCreate={(meta) => { setModal(false); onCreate(meta); }}
        ></CreateQuestModal>
      ) : null}
    </React.Fragment>
  );
}

Object.assign(window, { WspHeader, QuestListScreen, CreateQuestModal });
