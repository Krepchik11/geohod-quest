// GEOHOD QUEST — конструктор: пикер шаблонов, список страниц, версии,
// чек-лист публикации, модалка Publish. Редактор — в ctor/editor.jsx.
// Мини-превью используют НАСТОЯЩИЕ компоненты плеера (player/components.jsx).

const CTOR_TW = { art: "paper", layout: "image", anims: false, tone: "classic" };
const CTOR_STEP_BY_TPL = { start: 0, video: 1, continue: 2, task_no: 3, task_answer: 4, route_video: 5, congrats: 7 };

function AdmShell({ title, helper, children, minHeight }) {
  return (
    <div className="adm" style={{ width: "1240px", minHeight: (minHeight || 800) + "px", position: "relative" }}>
      <div className="adm-head">
        <span className="brand"></span>
        <nav className="adm-nav">
          <a href="#" className="active">Квесты</a>
          <a href="#" className="stub">Локации</a>
          <a href="#" className="stub">Купоны</a>
          <a href="#">Стат.</a>
          <a href="#">Пользователи</a>
          <a href="#">Галерея</a>
          <a href="#" className="stub">Комм.</a>
          <a href="#" className="stub">FAQ</a>
        </nav>
        <span className="s-avatar" style={{ background: "#fff" }}><span className="head"></span><span className="body"></span></span>
      </div>
      <h2 className="adm-title">{title}</h2>
      {helper ? <p className="adm-helper">{helper}</p> : null}
      <div className="adm-wrap">{children}</div>
    </div>
  );
}

function MiniTemplate({ tpl }) {
  const quest = window.QUEST_DEMO;
  const idx = CTOR_STEP_BY_TPL[tpl];
  const step = quest.steps[idx];
  const copy = window.UI_COPY.classic;
  return (
    <div className="mini">
      <PlayerFrame tw={CTOR_TW}>
        {tpl !== "start" ? <TopBar pos={idx + 1} total={quest.steps.length} coins={8}></TopBar> : null}
        {tpl === "congrats"
          ? <FinalB step={step} quest={quest} copy={copy}></FinalB>
          : <StepView step={step} quest={quest} copy={copy}></StepView>}
      </PlayerFrame>
    </div>
  );
}

/* ---------- Пикер A: сетка с живыми мини-превью (как в Figma) ---------- */
function PickerGrid() {
  const tpls = [
    { tpl: "start", name: "Первый экран" },
    { tpl: "video", name: "Приветственное видео" },
    { tpl: "task_no", name: "Задание без ответа" },
    { tpl: "task_answer", name: "Задание с ответом" },
    { tpl: "continue", name: "Продолжить" },
    { tpl: "route_video", name: "Видео маршрута" },
    { tpl: "congrats", name: "Поздравление" },
  ];
  return (
    <AdmShell title="Выбор шаблона страницы" helper="Нажмите на шаблон для создания новой страницы квеста" minHeight={1180}>
      <div className="tpick-grid">
        {tpls.map((t, i) => (
          <div key={t.tpl} className={"tpick-cell" + (i === 0 ? " selected" : "")}>
            <span className="name">{t.name}</span>
            <div className="tpick-frame">
              <MiniTemplate tpl={t.tpl}></MiniTemplate>
              {i === 0 ? <button className="adm-btn adm-btn--sm create" type="button">Создать</button> : null}
            </div>
          </div>
        ))}
      </div>
      <p className="adm-helper" style={{ marginTop: "20px", textAlign: "left" }}>Превью отрисованы настоящими компонентами плеера — шаблон выглядит так, как увидит игрок.</p>
    </AdmShell>
  );
}

/* ---------- Пикер B: список с описанием префиллов ---------- */
function PickerList() {
  const rows = [
    { n: 1, name: "Первый экран", desc: "Обложка квеста: название, город, длительность.", fills: <span><b>Префилл:</b> кнопка «начать квест», мета из настроек магазина</span> },
    { n: 2, name: "Приветственное видео", desc: "Знакомство с автором или сюжетом через видео.", fills: <span><b>Префилл:</b> видео-блок + кнопка «продолжить»</span> },
    { n: 3, name: "Задание без ответа", desc: "Дойти до места, иногда выполнить действие. Подтверждение на честность.", fills: <span><b>Префилл:</b> кнопка «Я на месте», навигатор вкл, заметка разрешена</span> },
    { n: 4, name: "Задание с ответом", desc: "Вопрос с проверкой по списку ответов. Ошибки ведут к подсказке за монеты.", fills: <span><b>Префилл:</b> поле «Введите ответ», подсказка 5 монет, подарок 5 монет</span> },
    { n: 5, name: "Продолжить", desc: "Развитие сюжета: диалог, факт, переход.", fills: <span><b>Префилл:</b> кнопка «продолжить»</span> },
    { n: 6, name: "Видео маршрута", desc: "Видео-навигация до следующей точки.", fills: <span><b>Префилл:</b> видео-блок + навигатор + «в путь»</span> },
    { n: 7, name: "Поздравление", desc: "Финал: бонус, итоги, приглашение оценить квест.", fills: <span><b>Префилл:</b> бонус +5 монет, блок оценки</span> },
  ];
  return (
    <AdmShell title="Выбор шаблона страницы" helper="Вариант B: список с пояснением, что предзаполнится" minHeight={1080}>
      <div className="tpick-list">
        {rows.map((r, i) => (
          <div key={r.n} className={"adm-card tpick-row" + (i === 3 ? " selected" : "")}>
            <span className="num">{r.n}</span>
            <span className="body"><b>{r.name}</b><p>{r.desc}</p></span>
            <span className="fills">{r.fills}</span>
            {i === 3 ? <button className="adm-btn adm-btn--sm" type="button">Создать</button> : null}
          </div>
        ))}
      </div>
    </AdmShell>
  );
}

/* ---------- Страницы квеста + версии ---------- */
function QuestPages() {
  const pages = [
    { n: 1, name: "«Первый экран»", tpl: "Первый экран", ok: true },
    { n: 2, name: "«Приветственное видео»", tpl: "Видео", ok: true },
    { n: 3, name: "«Завязка»", tpl: "Продолжить", ok: true },
    { n: 4, name: "«Задание без ответа 1»", tpl: "Задание без ответа", ok: false, err: "навигатор без координат" },
    { n: 5, name: "«Задание с ответом 1»", tpl: "Задание с ответом", ok: true },
    { n: 6, name: "«Задание с ответом 2»", tpl: "Задание с ответом", ok: false, err: "нет ответов" },
    { n: 7, name: "«Поздравление»", tpl: "Поздравление", ok: true },
  ];
  return (
    <AdmShell title="Редактирование квеста" helper="Страницы черновика. Публикация заморозит их в неизменяемую версию." minHeight={1150}>
      <div style={{ display: "flex", gap: "16px", alignItems: "center", flexWrap: "wrap" }}>
        <div>
          <label className="adm-label">Название квеста:</label>
          <input className="adm-input" defaultValue="Ирония судьбы"></input>
        </div>
        <button className="adm-btn" type="button" style={{ alignSelf: "flex-end" }}>Сохранить</button>
        <button className="adm-btn adm-btn--outline" type="button" style={{ alignSelf: "flex-end" }}>Открыть как тест-игрок</button>
        <button className="adm-btn adm-btn--outline" type="button" style={{ alignSelf: "flex-end" }}>Создать страницу</button>
      </div>

      <div className="adm-card" style={{ marginTop: "24px", padding: "8px 0" }}>
        {pages.map((p) => (
          <div className="pg-row" key={p.n}>
            <span className="grip">⠿</span>
            <span className="num">{p.n}.</span>
            <span className="nm">{p.name}</span>
            <span className="tpl">{p.tpl}</span>
            <span className={"gate " + (p.ok ? "ok" : "err")}>{p.ok ? "✓ готова" : "✗ " + p.err}</span>
            <button className="adm-btn adm-btn--sm" type="button">Редактировать</button>
            <button className="adm-btn adm-btn--danger adm-btn--sm" type="button">Удалить</button>
          </div>
        ))}
      </div>

      <div className="adm-card" style={{ marginTop: "24px" }}>
        <h4 style={{ margin: "0 0 8px", fontSize: "16px" }}>Версии</h4>
        <div className="ver-row">
          <span className="v">Черновик</span><span className="tag draft">не опубликован</span>
          <span className="meta">7 страниц · 2 ошибки гейтов</span>
          <button className="adm-btn adm-btn--sm adm-btn--outline" type="button">Чек-лист публикации</button>
        </div>
        <div className="ver-row">
          <span className="v">Версия 3</span><span className="tag live">текущая в магазине</span>
          <span className="meta">опубликована 02.05.2026 · 8 страниц · 4,8 МБ · 31 попытка</span>
        </div>
        <div className="ver-row">
          <span className="v">Версия 2</span><span className="tag old">архив</span>
          <span className="meta">12.03.2026 · 3 активных попытки остаются на ней</span>
        </div>
      </div>
      <p className="adm-helper" style={{ marginTop: "14px", textAlign: "left" }}>Версии неизменяемы: исправление ошибки = новая публикация. Игроки на старых версиях продолжают со своими правилами и суммами.</p>
    </AdmShell>
  );
}

/* ---------- Чек-лист публикации ---------- */
function PublishChecklist({ withModal }) {
  const gates = [
    { st: "ok", text: "Структура: первый экран в начале, есть терминальная страница «Поздравление»" },
    { st: "ok", text: "Комикс «task» загружен у всех страниц-заданий (4 из 4)" },
    { st: "err", text: "«Задание с ответом 2» — список ответов пуст", fix: true },
    { st: "err", text: "«Задание без ответа 1» — навигатор включён, но координаты не заданы", fix: true },
    { st: "warn", text: "Размер бандла ~5,6 МБ — выше цели 5 МБ (сожмите изображения или видео)" },
    { st: "ok", text: "Подсказки: стоимость и текст заданы у всех заданий с ответом" },
    { st: "ok", text: "Dry-run сериализации: снапшот собирается без ошибок" },
  ];
  const errors = gates.filter((g) => g.st === "err").length;
  return (
    <AdmShell title="Публикация квеста" helper="«Тяжело опубликовать плохое»: ошибки блокируют публикацию, предупреждения — нет" minHeight={withModal ? 900 : 860}>
      <div className="adm-card">
        <div className="gate-list">
          {gates.map((g, i) => (
            <div className={"gate-row " + g.st} key={i}>
              <span className="st">{g.st === "ok" ? "✓" : g.st === "err" ? "✗" : "!"}</span>
              <span>{g.text}</span>
              {g.fix ? <button className="adm-btn adm-btn--sm adm-btn--outline fix" type="button">Исправить</button> : null}
            </div>
          ))}
        </div>
        <div className="gate-sum">
          <span className="est">Оценка бандла: ~5,6 МБ · 7 страниц · 14 изображений · 2 видео · 1 озвучка</span>
          <button className="adm-btn adm-btn--outline" type="button">Dry-run сериализации</button>
          <button className="adm-btn" type="button" disabled={errors > 0 && !withModal}>{errors > 0 && !withModal ? `Опубликовать (${errors} ошибки)` : "Опубликовать"}</button>
        </div>
      </div>

      {withModal ? (
        <div className="adm-overlay">
          <div className="adm-modal">
            <h3>Опубликовать версию 4?</h3>
            <ul>
              <li>Создаётся <b>неизменяемый снапшот</b>: тексты, комиксы, списки ответов, суммы монет и стоимость подсказок замораживаются.</li>
              <li>Новые попытки игроков начнутся на версии 4. Активные попытки останутся на своих версиях.</li>
              <li>Откатить нельзя — исправления выходят следующей версией.</li>
            </ul>
            <p className="note">Бандл версии 4 (~4,9 МБ) соберётся и станет доступен для скачивания сразу после публикации.</p>
            <div className="row">
              <button className="adm-btn adm-btn--outline" type="button">Отмена</button>
              <button className="adm-btn" type="button">Опубликовать v4</button>
            </div>
          </div>
        </div>
      ) : null}
    </AdmShell>
  );
}

Object.assign(window, { AdmShell, PickerGrid, PickerList, QuestPages, PublishChecklist, MiniTemplate, CTOR_TW });
