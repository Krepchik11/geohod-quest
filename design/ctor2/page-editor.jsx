// GEOHOD QUEST — конструктор v2: редактор страницы (центр).
// Блоки зависят от шаблона; превью обновляется живьём (правая панель билдера).

function WspToggle({ on, onClick, label }) {
  return (
    <span className={"adm-toggle" + (on ? " on" : "")} onClick={onClick} role="switch" aria-checked={on}>
      <span className="tk"></span>{label}
    </span>
  );
}

function WspBlock({ title, aside, children }) {
  return (
    <div className="ed-block">
      <h4>{title}{aside ? <span className="opt">{aside}</span> : null}</h4>
      {children}
    </div>
  );
}

function WspDanger({ label, confirmLabel, onConfirm }) {
  const [arm, setArm] = React.useState(false);
  React.useEffect(() => {
    if (!arm) return undefined;
    const t = setTimeout(() => setArm(false), 2600);
    return () => clearTimeout(t);
  }, [arm]);
  return (
    <button className="adm-btn adm-btn--danger adm-btn--sm" type="button"
      onClick={() => { if (arm) { onConfirm(); setArm(false); } else { setArm(true); } }}>
      {arm ? confirmLabel : label}
    </button>
  );
}

/* ---------- Комикс страницы ---------- */
const WSP_COMIC_ROLES = {
  task_no: [
    { key: "task", label: "задание", req: true },
    { key: "character", label: "персонаж" },
    { key: "atmosphere", label: "атмосфера" },
  ],
  task_answer: [
    { key: "task", label: "задание", req: true },
    { key: "character", label: "персонаж" },
    { key: "hint", label: "подсказка" },
    { key: "atmosphere", label: "атмосфера" },
  ],
  continue: [{ key: "task", label: "иллюстрация" }],
};

function WspComic({ step, onPatch }) {
  const roles = WSP_COMIC_ROLES[step.template] || [];
  if (!roles.length) return null;
  const set = (k, v) => onPatch({ images: { ...step.images, [k]: v } });
  const cols = roles.length === 1 ? "repeat(2, 1fr)" : roles.length === 3 ? "repeat(3, 1fr)" : "repeat(4, 1fr)";
  return (
    <WspBlock title="Комикс страницы" aside={roles.length > 1 ? roles.length + " роли изображений" : "изображение"}>
      <div className="comic-grid" style={{ gridTemplateColumns: cols }}>
        {roles.map((r) => {
          const img = step.images && step.images[r.key];
          return (
            <div key={r.key}
              className={"comic-zone" + (img ? " filled" : "") + (r.req ? " req" : "")}
              onClick={() => { if (!img) set(r.key, WSP_DEMO_IMG[r.key] || WSP_DEMO_IMG.task); }}>
              {img
                ? <React.Fragment>
                    <img src={img} alt=""></img>
                    <span className="tag">{r.label}</span>
                    <button className="rm" type="button" aria-label="Убрать изображение"
                      onClick={(e) => { e.stopPropagation(); set(r.key, null); }}>✕</button>
                  </React.Fragment>
                : <React.Fragment><b>{r.label}</b>PNG/JPG до 1 МБ</React.Fragment>}
            </div>
          );
        })}
      </div>
      {step.template === "task_answer" ? (
        <p className="adm-helper" style={{ textAlign: "left", fontSize: "12px", margin: 0 }}>Роль «подсказка» игрок увидит только после покупки подсказки за монеты.</p>
      ) : null}
      <p className="adm-helper" style={{ textAlign: "left", fontSize: "11.5px", margin: 0, opacity: .7 }}>Прототип: клик по пустой зоне подставляет демо-изображение.</p>
    </WspBlock>
  );
}

/* ---------- Видео-блок ---------- */
function WspVideo({ step, onPatch }) {
  const v = step.video || { dur: "", label: "" };
  const set = (p) => onPatch({ video: { ...v, ...p } });
  return (
    <WspBlock title="Видео" aside="инлайн-блок на странице, не отдельный экран">
      <div className="wsp-vidzone">
        <span className="ring"><PPlay></PPlay></span>
        <span>{v.label || "видео"}</span>
        <span className="dur">{v.dur || "0:00"}</span>
      </div>
      <div className="wsp-trow">
        <div>
          <label className="adm-label">Длительность</label>
          <input className="adm-input adm-input--sm" value={v.dur} onChange={(e) => set({ dur: e.target.value })}></input>
        </div>
        <div className="wsp-grow">
          <label className="adm-label">Подпись постера</label>
          <input className="adm-input" value={v.label} onChange={(e) => set({ label: e.target.value })}></input>
        </div>
        <button className="adm-btn adm-btn--outline" type="button">Загрузить видео</button>
      </div>
    </WspBlock>
  );
}

/* ---------- Ответы + живой тест общим матчером ---------- */
function WspAnswers({ step, onPatch }) {
  const answers = step.acceptable || [];
  const [pasteOpen, setPasteOpen] = React.useState(false);
  const [pasteText, setPasteText] = React.useState("");
  const [testValue, setTestValue] = React.useState("");
  const clean = answers.map((a) => a.trim()).filter(Boolean);
  const verdict = testValue.trim() ? window.isAnswerCorrect(testValue, clean) : null;
  const setA = (arr) => onPatch({ acceptable: arr });
  const applyPaste = () => {
    const lines = pasteText.split("\n").map((s) => s.trim()).filter(Boolean);
    if (lines.length) setA(lines);
    setPasteOpen(false); setPasteText("");
  };
  return (
    <WspBlock title="Ответы" aside="регистр и пробелы по краям не важны">
      {answers.map((a, i) => (
        <div className="ans-row" key={i}>
          <input className="adm-input" value={a} onChange={(e) => setA(answers.map((x, j) => (j === i ? e.target.value : x)))}></input>
          <button className="del" type="button" aria-label="Удалить ответ" onClick={() => setA(answers.filter((_, j) => j !== i))}>✕</button>
        </div>
      ))}
      <div className="ans-add">
        <button className="adm-btn adm-btn--outline adm-btn--sm" type="button" onClick={() => setA([...answers, ""])}>+ Добавить ответ</button>
        <button className="adm-btn adm-btn--outline adm-btn--sm" type="button" onClick={() => setPasteOpen(!pasteOpen)}>Вставить строками</button>
      </div>
      {pasteOpen ? (
        <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
          <textarea className="adm-textarea" placeholder={"один ответ на строку\n1730\nв 1730"} value={pasteText} onChange={(e) => setPasteText(e.target.value)}></textarea>
          <button className="adm-btn adm-btn--sm" type="button" style={{ alignSelf: "flex-start" }} onClick={applyPaste}>Заменить список</button>
        </div>
      ) : null}
      <div className="ans-test">
        <input className="adm-input" placeholder="Тест: введите ответ как игрок…" value={testValue} onChange={(e) => setTestValue(e.target.value)}></input>
        {verdict === null
          ? <span className="ans-verdict" style={{ color: "var(--gray)" }}>—</span>
          : verdict
            ? <span className="ans-verdict ok">✓ зачтено</span>
            : <span className="ans-verdict no">✗ не зачтено</span>}
      </div>
      <p className="adm-helper" style={{ textAlign: "left", fontSize: "12px", margin: 0 }}>Проверяет та же функция, что и в плеере, — что зачтено здесь, зачтётся игроку.</p>
    </WspBlock>
  );
}

/* ---------- Подарок / Подсказка / Навигатор ---------- */
function WspGift({ step, onPatch }) {
  const g = step.gift;
  const set = (p) => onPatch({ gift: { ...g, ...p } });
  return (
    <WspBlock title="Подарок монет" aside="начислится при выполнении шага">
      <WspToggle on={g.on} onClick={() => set({ on: !g.on })} label="Дарить монеты за этот шаг"></WspToggle>
      {g.on ? (
        <React.Fragment>
          <div className="wsp-trow">
            <div>
              <label className="adm-label">Монеты</label>
              <input className="adm-input adm-input--sm" type="number" min="0" value={g.coins} onChange={(e) => set({ coins: +e.target.value || 0 })}></input>
            </div>
            <div className="wsp-grow">
              <label className="adm-label">Подпись к награде<small>появится в тосте: «+5 монет · Острый глаз!»</small></label>
              <input className="adm-input" value={g.narrative} onChange={(e) => set({ narrative: e.target.value })}></input>
            </div>
          </div>
          <p className="freeze-note">Сумма заморозится в снапшоте при публикации: игроки на этой версии всегда получат именно столько.</p>
        </React.Fragment>
      ) : null}
    </WspBlock>
  );
}

function WspHint({ step, onPatch }) {
  const h = step.hint;
  const set = (p) => onPatch({ hint: { ...h, ...p } });
  return (
    <WspBlock title="Подсказка" aside="попап после 2-й ошибки ответа">
      <WspToggle on={h.on} onClick={() => set({ on: !h.on })} label="Платная подсказка на этом шаге"></WspToggle>
      {h.on ? (
        <React.Fragment>
          <div className="wsp-trow">
            <div>
              <label className="adm-label">Стоимость, монет</label>
              <input className="adm-input adm-input--sm" type="number" min="0" value={h.cost} onChange={(e) => set({ cost: +e.target.value || 0 })}></input>
            </div>
            <div className="wsp-grow">
              <label className="adm-label">Текст подсказки<small>останется открытым до конца шага вместе с комиксом «подсказка»</small></label>
              <input className="adm-input" value={h.text} onChange={(e) => set({ text: e.target.value })}></input>
            </div>
          </div>
          <p className="freeze-note">Стоимость заморозится при публикации. Баланс игрока может уйти в минус — покупка никогда не блокируется.</p>
        </React.Fragment>
      ) : null}
    </WspBlock>
  );
}

function WspNav({ step, onPatch }) {
  const n = step.nav;
  const set = (p) => onPatch({ nav: { ...n, ...p } });
  const bad = n.on && (!String(n.lat).trim() || !String(n.lng).trim());
  return (
    <WspBlock title="Навигатор" aside="передача в системные карты, без маршрута в бандле">
      <WspToggle on={n.on} onClick={() => set({ on: !n.on })} label="Кнопка навигатора на странице"></WspToggle>
      {n.on ? (
        <React.Fragment>
          <div className="wsp-trow">
            <div>
              <label className="adm-label">Широта</label>
              <input className="adm-input adm-input--sm" value={n.lat} onChange={(e) => set({ lat: e.target.value })}></input>
            </div>
            <div>
              <label className="adm-label">Долгота</label>
              <input className="adm-input adm-input--sm" value={n.lng} onChange={(e) => set({ lng: e.target.value })}></input>
            </div>
            <div className="wsp-grow">
              <label className="adm-label">Подпись точки</label>
              <input className="adm-input" value={n.label} onChange={(e) => set({ label: e.target.value })}></input>
            </div>
          </div>
          {bad ? <p style={{ margin: 0, fontSize: "12.5px", color: "var(--pink)", fontWeight: 600 }}>✗ Координаты не заданы — публикация будет заблокирована.</p> : null}
        </React.Fragment>
      ) : null}
    </WspBlock>
  );
}

/* ---------- Контент-блоки по шаблонам ---------- */
function WspContentStart({ quest, step, set, onSettings }) {
  const m = quest.meta;
  return (
    <React.Fragment>
      <WspBlock title="Контент обложки">
        <div>
          <label className="adm-label">Надзаголовок<small>например «Городской квест»</small></label>
          <input className="adm-input" value={step.kicker} onChange={(e) => set({ kicker: e.target.value })}></input>
        </div>
        <div>
          <label className="adm-label">Подзаголовок<small>строка под названием</small></label>
          <input className="adm-input" value={step.text} onChange={(e) => set({ text: e.target.value })}></input>
        </div>
      </WspBlock>
      <WspBlock title="Из настроек квеста" aside="название, город, длительность, обложка">
        <div className="wsp-metacard">
          {m.cover ? <img src={m.cover} alt=""></img> : <span className="mc-ph">нет обложки</span>}
          <span className="mc-body">
            <b>{m.title}</b><br></br>
            <span>{[m.city, m.duration].filter(Boolean).join(" · ") || "город и длительность не заданы"}</span>
          </span>
          <button className="adm-btn adm-btn--outline adm-btn--sm" type="button" onClick={onSettings}>Открыть настройки</button>
        </div>
        <p className="adm-helper" style={{ textAlign: "left", fontSize: "12px", margin: 0 }}>«Первый экран» собирается из общих настроек квеста — они меняются в одном месте и для магазина, и для плеера.</p>
      </WspBlock>
    </React.Fragment>
  );
}

function WspContentTaskNo({ step, set }) {
  return (
    <WspBlock title="Контент">
      <div>
        <label className="adm-label">Текст задания</label>
        <textarea className="adm-textarea" value={step.text} onChange={(e) => set({ text: e.target.value })}></textarea>
      </div>
      <div>
        <label className="adm-label">Адрес и расстояние<small>строка с булавкой, например «ул. Николаевска порта 2 · 400 м отсюда»</small></label>
        <input className="adm-input" value={step.place} onChange={(e) => set({ place: e.target.value })}></input>
      </div>
      <div>
        <label className="adm-label">Действие на месте<small>необязательно</small></label>
        <input className="adm-input" value={step.action.desc} onChange={(e) => set({ action: { ...step.action, desc: e.target.value } })}></input>
      </div>
      <div className="wsp-trow">
        <div className="wsp-grow">
          <label className="adm-label">Кнопка подтверждения</label>
          <input className="adm-input" value={step.action.confirmLabel} onChange={(e) => set({ action: { ...step.action, confirmLabel: e.target.value } })}></input>
        </div>
        <div style={{ paddingBottom: "12px" }}>
          <WspToggle on={step.allowNote} onClick={() => set({ allowNote: !step.allowNote })} label="Разрешить заметку"></WspToggle>
        </div>
      </div>
      <p className="adm-helper" style={{ textAlign: "left", fontSize: "12px", margin: 0 }}>Подтверждение — на честность игрока: никакой проверки геолокации нет.</p>
    </WspBlock>
  );
}

/* ---------- Редактор страницы ---------- */
function PageEditor({ quest, step, msgs, onPatch, onDelete, onDuplicate, onSettings }) {
  const tplMeta = WSP_TPL_BY_KEY[step.template];
  const set = onPatch;
  const errs = (msgs || []).filter((m) => m.kind === "err");
  const tpl = step.template;
  return (
    <div className="ed-form" data-screen-label={"Редактор: " + step.name}>
      <div className="wsp-edhead">
        <span className="wsp-tplchip">{tplMeta.name}</span>
        {errs.length
          ? <span className="wsp-gatechip err">✗ {errs.length} {wspPlural(errs.length, "ошибка", "ошибки", "ошибок")}</span>
          : <span className="wsp-gatechip ok">✓ готова к публикации</span>}
        <span style={{ flex: 1 }}></span>
        <button className="adm-btn adm-btn--outline adm-btn--sm" type="button" onClick={onDuplicate}>Дублировать</button>
        <WspDanger label="Удалить" confirmLabel="Точно удалить?" onConfirm={onDelete}></WspDanger>
      </div>

      {errs.length ? (
        <div className="wsp-pageerrs">
          {errs.map((e, i) => <span key={i}>✗ {e.text}</span>)}
        </div>
      ) : null}

      <WspBlock title="Страница">
        <div>
          <label className="adm-label">Название<small>служебное, игрок не видит</small></label>
          <input className="adm-input" value={step.name} onChange={(e) => set({ name: e.target.value })}></input>
        </div>
      </WspBlock>

      {tpl === "start" ? <WspContentStart quest={quest} step={step} set={set} onSettings={onSettings}></WspContentStart> : null}

      {tpl === "video" || tpl === "route_video" ? (
        <React.Fragment>
          <WspVideo step={step} onPatch={set}></WspVideo>
          <WspBlock title="Контент">
            <div>
              <label className="adm-label">Текст под видео</label>
              <textarea className="adm-textarea" value={step.text} onChange={(e) => set({ text: e.target.value })}></textarea>
            </div>
          </WspBlock>
        </React.Fragment>
      ) : null}

      {tpl === "task_no" ? <WspContentTaskNo step={step} set={set}></WspContentTaskNo> : null}

      {tpl === "task_answer" ? (
        <WspBlock title="Контент">
          <div>
            <label className="adm-label">Текст задания</label>
            <textarea className="adm-textarea" value={step.text} onChange={(e) => set({ text: e.target.value })}></textarea>
          </div>
          <div>
            <label className="adm-label">Плейсхолдер поля ответа</label>
            <input className="adm-input" value={step.prompt} onChange={(e) => set({ prompt: e.target.value })}></input>
          </div>
        </WspBlock>
      ) : null}

      {tpl === "continue" ? (
        <WspBlock title="Контент">
          <div>
            <label className="adm-label">Текст<small>поддерживает абзацы — пустая строка между ними</small></label>
            <textarea className="adm-textarea" style={{ minHeight: "140px" }} value={step.text} onChange={(e) => set({ text: e.target.value })}></textarea>
          </div>
        </WspBlock>
      ) : null}

      {tpl === "congrats" ? (
        <React.Fragment>
          <WspBlock title="Контент финала">
            <div>
              <label className="adm-label">Заголовок</label>
              <input className="adm-input" value={step.title} onChange={(e) => set({ title: e.target.value })}></input>
            </div>
            <div>
              <label className="adm-label">Финальный текст<small>развязка истории</small></label>
              <textarea className="adm-textarea" value={step.text} onChange={(e) => set({ text: e.target.value })}></textarea>
            </div>
          </WspBlock>
          <WspBlock title="Встроено в шаблон" aside="настраивается платформой, не квестом">
            <p className="freeze-note" style={{ margin: 0 }}>+5 монет — бонус за первое прохождение (идемпотентно: повторные прохождения бонус не дублируют).</p>
            <p className="adm-helper" style={{ textAlign: "left", fontSize: "12px", margin: 0 }}>Итоги (монеты, время, шаги) и блок оценки ★★★★★ встроены в шаблон — видно в превью справа.</p>
          </WspBlock>
        </React.Fragment>
      ) : null}

      <WspComic step={step} onPatch={set}></WspComic>

      {tpl === "task_answer" ? <WspAnswers step={step} onPatch={set}></WspAnswers> : null}
      {tpl === "task_no" || tpl === "task_answer" ? <WspGift step={step} onPatch={set}></WspGift> : null}
      {tpl === "task_answer" ? <WspHint step={step} onPatch={set}></WspHint> : null}
      {tpl === "task_no" || tpl === "task_answer" || tpl === "route_video" || tpl === "video" ? <WspNav step={step} onPatch={set}></WspNav> : null}

      <p className="adm-helper" style={{ textAlign: "left", margin: 0 }}>Автосохранение в черновик. Игроки увидят изменения только после публикации новой версии.</p>
    </div>
  );
}

Object.assign(window, { WspToggle, WspBlock, WspDanger, WspComic, WspVideo, WspAnswers, WspGift, WspHint, WspNav, PageEditor });
