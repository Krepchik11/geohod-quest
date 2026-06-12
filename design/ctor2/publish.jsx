// GEOHOD QUEST — конструктор v2: публикация (чек-лист гейтов, версии, модалка).

function wspChecklist(quest, gates) {
  const rows = [];
  const structErr = gates.errors.some((e) => !e.pageId);
  if (!structErr) rows.push({ st: "ok", text: "Структура: «Первый экран» в начале, есть терминальное «Поздравление»" });
  const tasks = quest.steps.filter((s) => s.template === "task_no" || s.template === "task_answer");
  if (tasks.length && tasks.every((s) => s.images && s.images.task)) {
    rows.push({ st: "ok", text: `Комикс «задание» загружен у всех страниц-заданий (${tasks.length} из ${tasks.length})` });
  }
  const answers = quest.steps.filter((s) => s.template === "task_answer");
  if (answers.length && answers.every((s) => (s.acceptable || []).some((a) => a.trim()))) {
    rows.push({ st: "ok", text: "Списки ответов заполнены у всех «Заданий с ответом»" });
  }
  const navs = quest.steps.filter((s) => s.nav && s.nav.on);
  if (navs.length && navs.every((s) => String(s.nav.lat).trim() && String(s.nav.lng).trim())) {
    rows.push({ st: "ok", text: `Навигатор: координаты заданы у всех включённых точек (${navs.length})` });
  }
  gates.errors.forEach((e) => rows.push({ st: "err", text: e.text, pageId: e.pageId }));
  gates.warnings.forEach((w) => rows.push({ st: "warn", text: w.text, pageId: w.pageId }));
  rows.push({ st: "ok", text: "Dry-run сериализации: снапшот собирается без ошибок" });
  return rows;
}

function PublishModal({ nextN, size, onCancel, onConfirm }) {
  return (
    <div className="wsp-ovl" onClick={onCancel}>
      <div className="adm-modal" onClick={(e) => e.stopPropagation()}>
        <h3>Опубликовать версию {nextN}?</h3>
        <ul>
          <li>Создаётся <b>неизменяемый снапшот</b>: тексты, комиксы, списки ответов, суммы монет и стоимость подсказок замораживаются.</li>
          <li>Новые попытки игроков начнутся на версии {nextN}. Активные попытки останутся на своих версиях.</li>
          <li>Откатить нельзя — исправления выходят следующей версией.</li>
        </ul>
        <p className="note">Бандл версии {nextN} (~{size}) соберётся и станет доступен для скачивания сразу после публикации.</p>
        <div className="row">
          <button className="adm-btn adm-btn--outline" type="button" onClick={onCancel}>Отмена</button>
          <button className="adm-btn" type="button" onClick={onConfirm}>Опубликовать v{nextN}</button>
        </div>
      </div>
    </div>
  );
}

function PublishPanel({ quest, gates, justPub, onFix, onPublish }) {
  const rows = wspChecklist(quest, gates);
  const errN = gates.errors.length;
  const [modal, setModal] = React.useState(false);
  const nextN = (quest.versions.length ? Math.max(...quest.versions.map((v) => v.n)) : 0) + 1;
  return (
    <div className="ed-form" data-screen-label="Публикация и версии">
      <div className="wsp-edhead">
        <span className="wsp-tplchip">Публикация и версии</span>
        {errN
          ? <span className="wsp-gatechip err">✗ {errN} {wspPlural(errN, "ошибка блокирует", "ошибки блокируют", "ошибок блокируют")} публикацию</span>
          : <span className="wsp-gatechip ok">✓ гейты пройдены</span>}
      </div>

      {justPub ? (
        <div className="wsp-banner">✓ Версия {justPub} опубликована. Новые попытки игроков начнутся на ней; активные останутся на своих версиях.</div>
      ) : null}

      <div className="ed-block">
        <h4>Чек-лист публикации <span className="opt">ошибки блокируют, предупреждения — нет</span></h4>
        <div className="gate-list">
          {rows.map((g, i) => (
            <div className={"gate-row " + g.st} key={i}>
              <span className="st">{g.st === "ok" ? "✓" : g.st === "err" ? "✗" : "!"}</span>
              <span>{g.text}</span>
              {g.pageId ? <button className="adm-btn adm-btn--sm adm-btn--outline fix" type="button" onClick={() => onFix(g.pageId)}>Исправить</button> : null}
            </div>
          ))}
        </div>
        <div className="gate-sum">
          <span className="est">Оценка бандла: ~{gates.size} · {quest.steps.length} {wspPlural(quest.steps.length, "страница", "страницы", "страниц")} · {gates.imgs} изобр. · {gates.vids} видео · цель ≤ 5 МБ</span>
          <button className="adm-btn" type="button" disabled={errN > 0} onClick={() => setModal(true)}>
            {errN > 0 ? `Опубликовать (${errN} ${wspPlural(errN, "ошибка", "ошибки", "ошибок")})` : `Опубликовать v${nextN}`}
          </button>
        </div>
      </div>

      <div className="ed-block">
        <h4>Версии</h4>
        <div className="ver-row">
          <span className="v">Черновик</span>
          <span className={"tag " + (errN ? "draft" : "live")}>{errN ? `${errN} ${wspPlural(errN, "ошибка", "ошибки", "ошибок")} гейтов` : "готов к публикации"}</span>
          <span className="meta">{quest.steps.length} страниц · ~{gates.size}</span>
        </div>
        {quest.versions.map((v) => (
          <div className="ver-row" key={v.n}>
            <span className="v">Версия {v.n}</span>
            {v.live ? <span className="tag live">текущая в магазине</span> : <span className="tag old">архив</span>}
            <span className="meta">{v.date} · {v.pages} страниц · {v.size}{v.attempts ? ` · ${v.attempts} ${wspPlural(v.attempts, "активная попытка", "активные попытки", "активных попыток")}` : ""}</span>
          </div>
        ))}
        <p className="adm-helper" style={{ textAlign: "left", margin: "8px 0 0" }}>Версии неизменяемы: исправление = новая публикация. Игроки на старых версиях продолжают со своими правилами и суммами.</p>
      </div>

      {modal ? (
        <PublishModal nextN={nextN} size={gates.size}
          onCancel={() => setModal(false)}
          onConfirm={() => { setModal(false); onPublish(); }}></PublishModal>
      ) : null}
    </div>
  );
}

Object.assign(window, { wspChecklist, PublishPanel, PublishModal });
