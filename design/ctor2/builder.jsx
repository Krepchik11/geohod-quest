// GEOHOD QUEST — конструктор v2: билдер (рельса страниц · редактор · живое превью),
// настройки квеста, пикер шаблонов с живыми мини-превью плеера.

/* ---------- Мини-превью шаблона настоящими компонентами плеера ---------- */
const WSP_MINI_IDX = { start: 0, video: 1, continue: 2, task_no: 3, task_answer: 4, route_video: 5, congrats: 7 };

function WspMiniTpl({ tpl }) {
  const quest = window.QUEST_DEMO;
  const idx = WSP_MINI_IDX[tpl];
  const step = quest.steps[idx];
  const copy = window.UI_COPY.classic;
  return (
    <div className="mini">
      <PlayerFrame tw={{ art: "paper", layout: "image", anims: false }}>
        {tpl !== "start" ? <TopBar pos={idx + 1} total={quest.steps.length} coins={8}></TopBar> : null}
        {tpl === "congrats"
          ? <FinalB step={step} quest={quest} copy={copy}></FinalB>
          : <StepView step={step} quest={quest} copy={copy}></StepView>}
      </PlayerFrame>
    </div>
  );
}

function TemplatePickerModal({ onClose, onPick }) {
  return (
    <div className="wsp-ovl" onClick={onClose}>
      <div className="wsp-tpick" onClick={(e) => e.stopPropagation()}>
        <h3>Новая страница — выберите шаблон</h3>
        <p className="sub">Страница добавится после текущей, но не позже финального «Поздравления». Превью отрисованы настоящими компонентами плеера.</p>
        <div className="wsp-tgrid">
          {WSP_TEMPLATES.map((t) => (
            <div key={t.key} className="wsp-tcell" onClick={() => onPick(t.key)}>
              <div className="frame"><WspMiniTpl tpl={t.key}></WspMiniTpl></div>
              <span className="nm">{t.name}</span>
              <span className="fl"><b>Префилл:</b> {t.fill}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/* ---------- Настройки квеста ---------- */
function QuestSettings({ quest, onMeta }) {
  const m = quest.meta;
  const set = (p) => onMeta({ ...m, ...p });
  return (
    <div className="ed-form" data-screen-label="Настройки квеста">
      <div className="wsp-edhead">
        <span className="wsp-tplchip">Настройки квеста</span>
      </div>
      <WspBlock title="Карточка квеста" aside="используется «Первым экраном» и магазином">
        <div>
          <label className="adm-label">Название</label>
          <input className="adm-input" value={m.title} onChange={(e) => set({ title: e.target.value })}></input>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: "12px" }}>
          <div>
            <label className="adm-label">Город</label>
            <input className="adm-input" value={m.city} onChange={(e) => set({ city: e.target.value })}></input>
          </div>
          <div>
            <label className="adm-label">Длительность</label>
            <input className="adm-input" placeholder="2–3 часа" value={m.duration} onChange={(e) => set({ duration: e.target.value })}></input>
          </div>
          <div>
            <label className="adm-label">Цена, ₽</label>
            <input className="adm-input" type="number" min="0" value={m.price} onChange={(e) => set({ price: +e.target.value || 0 })}></input>
          </div>
        </div>
        <div>
          <label className="adm-label">Описание для магазина</label>
          <textarea className="adm-textarea" value={m.desc} onChange={(e) => set({ desc: e.target.value })}></textarea>
        </div>
        <p className="adm-helper" style={{ textAlign: "left", fontSize: "12px", margin: 0 }}>0 ₽ — бесплатный квест. Оплата, купоны и выдача доступов — на стороне магазина, не конструктора.</p>
      </WspBlock>
      <WspBlock title="Обложка" aside="первый экран и карточка магазина">
        <div className={"comic-zone" + (m.cover ? " filled" : "")} style={{ width: "240px" }}
          onClick={() => { if (!m.cover) set({ cover: WSP_DEMO_IMG.cover }); }}>
          {m.cover
            ? <React.Fragment>
                <img src={m.cover} alt=""></img>
                <span className="tag">обложка</span>
                <button className="rm" type="button" aria-label="Убрать обложку" onClick={(e) => { e.stopPropagation(); set({ cover: null }); }}>✕</button>
              </React.Fragment>
            : <React.Fragment><b>обложка</b>PNG/JPG · прототип: клик ставит демо-файл</React.Fragment>}
        </div>
      </WspBlock>
    </div>
  );
}

/* ---------- Превью-панель: настоящие компоненты плеера ---------- */
function PreviewPanel({ quest, idx, tone, onTestFrom }) {
  const pquest = wspSerialize(quest);
  const total = pquest.steps.length;
  const i = Math.max(0, Math.min(idx, total - 1));
  const ps = total ? pquest.steps[i] : null;
  const [hintOn, setHintOn] = React.useState(false);
  const [wrongOn, setWrongOn] = React.useState(false);
  React.useEffect(() => { setHintOn(false); setWrongOn(false); }, [ps && ps.id]);
  if (!ps) {
    return <aside className="wsp-preview"><p className="cap">Нет страниц — превью появится после добавления первой.</p></aside>;
  }
  return (
    <aside className="wsp-preview">
      <p className="cap">Живое превью — настоящие компоненты плеера · {i + 1} / {total}</p>
      <div className="wsp-phone">
        <PlayerFrame tw={{ art: "paper", layout: "image", anims: false }}>
          {ps.template !== "start" ? <TopBar pos={i + 1} total={total} coins={8}></TopBar> : null}
          {ps.template === "congrats"
            ? <FinalB step={ps} quest={pquest} copy={window.UI_COPY[tone] || window.UI_COPY.classic}></FinalB>
            : <StepView step={ps} quest={pquest} copy={window.UI_COPY[tone] || window.UI_COPY.classic} st={{ hintRevealed: hintOn, wrong: wrongOn }}></StepView>}
        </PlayerFrame>
      </div>
      {ps.hint ? <WspToggle on={hintOn} onClick={() => setHintOn(!hintOn)} label="С купленной подсказкой"></WspToggle> : null}
      {ps.template === "task_answer" ? <WspToggle on={wrongOn} onClick={() => setWrongOn(!wrongOn)} label="С ошибкой ответа"></WspToggle> : null}
      <button className="adm-btn adm-btn--outline" type="button" style={{ width: "100%" }} onClick={() => onTestFrom(i)}>▶ Тест с этой страницы</button>
    </aside>
  );
}

/* ---------- Строка страницы в рельсе ---------- */
function WspPageRow({ s, i, active, msgs, onClick, drag }) {
  const errs = (msgs || []).filter((m) => m.kind === "err");
  return (
    <div
      className={"wsp-page" + (active ? " active" : "") + (drag.over ? " dragover" : "")}
      onClick={onClick}
      draggable="true"
      onDragStart={drag.start}
      onDragOver={drag.overHandler}
      onDragLeave={drag.leave}
      onDrop={drag.drop}
      title={errs.map((e) => e.text).join("\n") || undefined}
    >
      <span className="grip">⠿</span>
      <span className="num">{i + 1}</span>
      <span className="body">
        <span className="nm">{s.name || WSP_TPL_BY_KEY[s.template].name}</span>
        <span className="tp">{WSP_TPL_BY_KEY[s.template].name}</span>
      </span>
      <span className={"dot " + (errs.length ? "err" : "ok")}></span>
    </div>
  );
}

/* ---------- Билдер ---------- */
function BuilderScreen({ quest, sel, onSel, onPatchQuest, onBack, onTest, tone }) {
  const gates = wspGates(quest);
  const steps = quest.steps;
  const selStep = sel && sel.type === "page" ? steps.find((s) => s.id === sel.id) : null;
  const view = sel && (sel.type === "settings" || sel.type === "publish") ? sel.type : (selStep ? "page" : "settings");
  const selIdx = selStep ? steps.indexOf(selStep) : 0;
  const [picker, setPicker] = React.useState(false);
  const [justPub, setJustPub] = React.useState(null);
  const [dragFrom, setDragFrom] = React.useState(null);
  const [dragOver, setDragOver] = React.useState(null);
  const live = quest.versions.find((v) => v.live);
  const errN = gates.errors.length;

  React.useEffect(() => { if (view !== "publish") setJustPub(null); }, [view]);

  const patchStep = (id, patch) => onPatchQuest((q) => ({
    ...q, steps: q.steps.map((s) => (s.id === id ? { ...s, ...patch } : s)),
  }));

  const insertStep = (tplKey) => {
    const ns = wspNewStep(tplKey);
    onPatchQuest((q) => {
      const arr = [...q.steps];
      let i = selStep ? arr.findIndex((s) => s.id === selStep.id) + 1 : arr.length;
      if (i <= 0) i = arr.length;
      if (i === arr.length && arr.length && arr[arr.length - 1].template === "congrats" && tplKey !== "congrats") i = arr.length - 1;
      arr.splice(i, 0, ns);
      return { ...q, steps: arr };
    });
    onSel({ type: "page", id: ns.id });
  };

  const removeStep = (id) => {
    const i = steps.findIndex((s) => s.id === id);
    const nb = steps[i + 1] || steps[i - 1];
    onPatchQuest((q) => ({ ...q, steps: q.steps.filter((s) => s.id !== id) }));
    onSel(nb ? { type: "page", id: nb.id } : { type: "settings" });
  };

  const duplicateStep = (id) => {
    const src = steps.find((s) => s.id === id);
    const copy = JSON.parse(JSON.stringify(src));
    copy.id = wspUid();
    copy.name = src.name + " (копия)";
    onPatchQuest((q) => {
      const arr = [...q.steps];
      arr.splice(arr.findIndex((s) => s.id === id) + 1, 0, copy);
      return { ...q, steps: arr };
    });
    onSel({ type: "page", id: copy.id });
  };

  const reorder = (from, to) => {
    if (from === null || to === null || from === to) return;
    onPatchQuest((q) => {
      const arr = [...q.steps];
      const [moved] = arr.splice(from, 1);
      arr.splice(to, 0, moved);
      return { ...q, steps: arr };
    });
  };

  const nextN = (quest.versions.length ? Math.max(...quest.versions.map((v) => v.n)) : 0) + 1;
  const doPublish = () => {
    onPatchQuest((q) => ({
      ...q,
      versions: [
        { n: nextN, date: new Date().toLocaleDateString("ru-RU"), pages: q.steps.length, size: gates.size, live: true, attempts: 0 },
        ...q.versions.map((v) => ({ ...v, live: false })),
      ],
    }));
    setJustPub(nextN);
  };

  return (
    <React.Fragment>
      <WspHeader crumbs={
        <React.Fragment>
          <a onClick={onBack}>Квесты</a>
          <span>/</span>
          <b>{quest.meta.title}</b>
        </React.Fragment>
      }>
        <span className="wsp-save">{quest.lastSaved ? "Черновик сохранён · " + wspFmtTime(quest.lastSaved) : "Черновик"}</span>
        <button className="adm-btn adm-btn--outline" type="button" onClick={() => onTest(0)}>▶ Тест-игрок</button>
        <button className="adm-btn" type="button" onClick={() => onSel({ type: "publish" })}>
          {errN ? `Опубликовать · ${errN} ${wspPlural(errN, "ошибка", "ошибки", "ошибок")}` : "Опубликовать"}
        </button>
      </WspHeader>

      <div className="wsp-builder" data-screen-label={"Билдер: " + quest.meta.title}>
        <nav className="wsp-rail">
          <h5>Квест</h5>
          <div className={"wsp-navitem" + (view === "settings" ? " active" : "")} onClick={() => onSel({ type: "settings" })}>Настройки и обложка</div>
          <div className={"wsp-navitem" + (view === "publish" ? " active" : "")} onClick={() => onSel({ type: "publish" })}>
            Публикация и версии
            {errN ? <span className="wsp-chip err">{errN}</span> : null}
          </div>
          <h5>Страницы ({steps.length})</h5>
          <div>
            {steps.map((s, i) => (
              <WspPageRow key={s.id} s={s} i={i}
                active={!!(selStep && selStep.id === s.id)}
                msgs={gates.perPage[s.id]}
                onClick={() => onSel({ type: "page", id: s.id })}
                drag={{
                  over: dragOver === i && dragFrom !== i,
                  start: (e) => { setDragFrom(i); e.dataTransfer.effectAllowed = "move"; },
                  overHandler: (e) => { e.preventDefault(); setDragOver(i); },
                  leave: () => setDragOver(null),
                  drop: (e) => { e.preventDefault(); reorder(dragFrom, i); setDragFrom(null); setDragOver(null); },
                }}
              ></WspPageRow>
            ))}
          </div>
          <button className="adm-btn adm-btn--outline adm-btn--sm wsp-addpage" type="button" onClick={() => setPicker(true)}>+ Добавить страницу</button>
          <div className="wsp-vers">
            {live
              ? <span className="wsp-ver"><b>v{live.n}</b>&nbsp;в магазине · {live.attempts} {wspPlural(live.attempts, "попытка", "попытки", "попыток")}</span>
              : <span className="wsp-ver">Ещё не опубликован</span>}
            <span className="wsp-ver">Версии неизменяемы — правки выходят новой публикацией.</span>
          </div>
        </nav>

        <main className="wsp-center">
          {view === "publish" ? (
            <PublishPanel quest={quest} gates={gates} justPub={justPub}
              onFix={(pid) => pid && onSel({ type: "page", id: pid })}
              onPublish={doPublish}></PublishPanel>
          ) : view === "settings" ? (
            <QuestSettings quest={quest} onMeta={(m) => onPatchQuest((q) => ({ ...q, meta: m }))}></QuestSettings>
          ) : (
            <PageEditor quest={quest} step={selStep}
              msgs={gates.perPage[selStep.id]}
              onPatch={(p) => patchStep(selStep.id, p)}
              onDelete={() => removeStep(selStep.id)}
              onDuplicate={() => duplicateStep(selStep.id)}
              onSettings={() => onSel({ type: "settings" })}></PageEditor>
          )}
        </main>

        <PreviewPanel quest={quest} idx={view === "page" ? selIdx : 0} tone={tone} onTestFrom={(i) => onTest(i)}></PreviewPanel>
      </div>

      {picker ? (
        <TemplatePickerModal onClose={() => setPicker(false)}
          onPick={(k) => { setPicker(false); insertStep(k); }}></TemplatePickerModal>
      ) : null}
    </React.Fragment>
  );
}

Object.assign(window, { WspMiniTpl, TemplatePickerModal, QuestSettings, PreviewPanel, BuilderScreen });
