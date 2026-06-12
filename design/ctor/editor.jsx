// GEOHOD QUEST — редактор страницы (полный пер-степ редактор, интерактивный).
// Живое превью настоящими компонентами плеера; «Тест ответа» использует
// ТУ ЖЕ функцию isAnswerCorrect, что и плеер (player/matcher.js).

function Toggle({ on, onClick, label }) {
  return (
    <span className={"adm-toggle" + (on ? " on" : "")} onClick={onClick} role="switch" aria-checked={on}>
      <span className="tk"></span>{label}
    </span>
  );
}

function StepEditor() {
  const [name, setName] = React.useState("Задание с ответом 1");
  const [text, setText] = React.useState("Взгляните на табличку над входом. В каком году храм был освящён после перестройки?");
  const [prompt, setPrompt] = React.useState("Введите год");
  const [answers, setAnswers] = React.useState(["1730", "в 1730", "1730 год"]);
  const [pasteOpen, setPasteOpen] = React.useState(false);
  const [pasteText, setPasteText] = React.useState("");
  const [testValue, setTestValue] = React.useState("");
  const [giftCoins, setGiftCoins] = React.useState(5);
  const [giftText, setGiftText] = React.useState("Острый глаз!");
  const [hintCost, setHintCost] = React.useState(5);
  const [hintText, setHintText] = React.useState("Цифры выбиты в каменной арке над дверью — две первые уже видны с дорожки.");
  const [navOn, setNavOn] = React.useState(false);
  const [previewHint, setPreviewHint] = React.useState(false);

  const verdict = testValue.trim() ? window.isAnswerCorrect(testValue, answers) : null;
  const quest = window.QUEST_DEMO;
  const copy = window.UI_COPY.classic;

  const previewStep = {
    template: "task_answer", name,
    image: "assets/img/church.jpg",
    text, prompt,
    acceptable: answers,
    gift: { coins: giftCoins, narrative: giftText },
    hint: { cost: hintCost, text: hintText },
  };

  const applyPaste = () => {
    const lines = pasteText.split("\n").map((s) => s.trim()).filter(Boolean);
    if (lines.length) setAnswers(lines);
    setPasteOpen(false); setPasteText("");
  };

  return (
    <AdmShell title="Редактирование страницы" minHeight={1660}>
      <div className="ed-crumbs">
        <span>Квест <b>«Ирония судьбы»</b></span>·<span>Страница <b>«{name}»</b></span>
        <span className="nav">
          <button className="adm-btn adm-btn--sm adm-btn--outline" type="button">← Пред.</button>
          <button className="adm-btn adm-btn--sm adm-btn--outline" type="button">След. →</button>
        </span>
      </div>

      <div className="ed-cols">
        <div className="ed-form">
          <div className="ed-block">
            <h4>Шаблон <span className="chip">Задание с ответом</span></h4>
            <div>
              <label className="adm-label">Название страницы<small>служебное, игрок не видит</small></label>
              <input className="adm-input adm-input--wide" style={{ height: "52px", fontSize: "15px" }} value={name} onChange={(e) => setName(e.target.value)}></input>
            </div>
          </div>

          <div className="ed-block">
            <h4>Контент</h4>
            <div>
              <label className="adm-label">Текст задания</label>
              <textarea className="adm-textarea" value={text} onChange={(e) => setText(e.target.value)}></textarea>
            </div>
            <div>
              <label className="adm-label">Плейсхолдер поля ответа</label>
              <input className="adm-input" style={{ height: "52px", fontSize: "15px" }} value={prompt} onChange={(e) => setPrompt(e.target.value)}></input>
            </div>
          </div>

          <div className="ed-block">
            <h4>Комикс страницы <span className="opt">4 роли изображений</span></h4>
            <div className="comic-grid">
              <div className="comic-zone filled req"><img src="assets/img/church.jpg" alt=""></img><span className="tag">задание</span></div>
              <div className="comic-zone"><b>персонаж</b>PNG/JPG до 1 МБ</div>
              <div className="comic-zone"><b>подсказка</b>откроется за монеты</div>
              <div className="comic-zone"><b>атмосфера</b>фон страницы</div>
            </div>
          </div>

          <div className="ed-block">
            <h4>Ответы <span className="opt">регистр и пробелы по краям не важны</span></h4>
            {answers.map((a, i) => (
              <div className="ans-row" key={i}>
                <input className="adm-input" value={a} onChange={(e) => setAnswers(answers.map((x, j) => j === i ? e.target.value : x))}></input>
                <button className="del" type="button" aria-label="Удалить ответ" onClick={() => setAnswers(answers.filter((_, j) => j !== i))}>✕</button>
              </div>
            ))}
            <div className="ans-add">
              <button className="adm-btn adm-btn--sm adm-btn--outline" type="button" onClick={() => setAnswers([...answers, ""])}>+ Добавить ответ</button>
              <button className="adm-btn adm-btn--sm adm-btn--outline" type="button" onClick={() => setPasteOpen(!pasteOpen)}>Вставить строками</button>
            </div>
            {pasteOpen ? (
              <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
                <textarea className="adm-textarea" placeholder={"один ответ на строку\n1730\nв 1730"} value={pasteText} onChange={(e) => setPasteText(e.target.value)}></textarea>
                <button className="adm-btn adm-btn--sm" type="button" style={{ alignSelf: "flex-start" }} onClick={applyPaste}>Заменить список</button>
              </div>
            ) : null}
            <div className="ans-test">
              <input className="adm-input" placeholder="Тест: введите ответ как игрок…" value={testValue} onChange={(e) => setTestValue(e.target.value)}></input>
              {verdict === null ? <span className="ans-verdict" style={{ color: "var(--gray)" }}>—</span>
                : verdict ? <span className="ans-verdict ok">✓ зачтено</span>
                : <span className="ans-verdict no">✗ не зачтено</span>}
            </div>
            <p className="adm-helper" style={{ textAlign: "left", fontSize: "12px" }}>Проверяет та же функция, что и в плеере, — что зачтено здесь, зачтётся игроку.</p>
          </div>

          <div className="ed-block">
            <h4>Подарок за выполнение</h4>
            <div style={{ display: "flex", gap: "12px", alignItems: "flex-end", flexWrap: "wrap" }}>
              <div>
                <label className="adm-label">Монеты</label>
                <input className="adm-input adm-input--sm" type="number" value={giftCoins} onChange={(e) => setGiftCoins(+e.target.value || 0)}></input>
              </div>
              <div style={{ flex: 1, minWidth: "240px" }}>
                <label className="adm-label">Подпись к награде</label>
                <input className="adm-input adm-input--wide" style={{ height: "48px", fontSize: "14px" }} value={giftText} onChange={(e) => setGiftText(e.target.value)}></input>
              </div>
            </div>
            <p className="freeze-note">Сумма заморозится в снапшоте при публикации: игроки на этой версии всегда получат именно столько.</p>
          </div>

          <div className="ed-block">
            <h4>Подсказка <span className="opt">появится в попапе после 2-й ошибки</span></h4>
            <div style={{ display: "flex", gap: "12px", alignItems: "flex-end", flexWrap: "wrap" }}>
              <div>
                <label className="adm-label">Стоимость, монет</label>
                <input className="adm-input adm-input--sm" type="number" value={hintCost} onChange={(e) => setHintCost(+e.target.value || 0)}></input>
              </div>
              <div style={{ flex: 1, minWidth: "240px" }}>
                <label className="adm-label">Текст подсказки</label>
                <input className="adm-input adm-input--wide" style={{ height: "48px", fontSize: "14px" }} value={hintText} onChange={(e) => setHintText(e.target.value)}></input>
              </div>
            </div>
          </div>

          <div className="ed-block">
            <h4>Навигатор <span className="opt">обычно для заданий без ответа</span></h4>
            <Toggle on={navOn} onClick={() => setNavOn(!navOn)} label="Кнопка навигатора на странице"></Toggle>
            {navOn ? (
              <div style={{ display: "flex", gap: "12px", flexWrap: "wrap" }}>
                <div><label className="adm-label">Широта</label><input className="adm-input adm-input--sm" defaultValue="45.2551"></input></div>
                <div><label className="adm-label">Долгота</label><input className="adm-input adm-input--sm" defaultValue="19.8451"></input></div>
                <div style={{ flex: 1, minWidth: "200px" }}><label className="adm-label">Подпись точки</label><input className="adm-input adm-input--wide" style={{ height: "48px", fontSize: "14px" }} defaultValue="Николаевская церковь"></input></div>
              </div>
            ) : null}
          </div>

          <div style={{ display: "flex", gap: "14px", alignItems: "center" }}>
            <button className="adm-btn" type="button">Сохранить</button>
            <button className="adm-btn adm-btn--outline" type="button">Открыть как тест-игрок</button>
            <button className="adm-btn adm-btn--danger" type="button">Удалить страницу</button>
          </div>
          <p className="adm-helper" style={{ textAlign: "left", marginTop: "-10px" }}>Изменения сохраняются в черновик — игроки увидят их только после публикации новой версии.</p>
        </div>

        <div className="ed-preview">
          <p className="cap">Живое превью — настоящие компоненты плеера</p>
          <div className="ed-phone">
            <PlayerFrame tw={CTOR_TW}>
              <TopBar pos={5} total={8} coins={8}></TopBar>
              <StepView step={previewStep} quest={window.QUEST_DEMO} copy={copy} st={{ hintRevealed: previewHint }}></StepView>
            </PlayerFrame>
          </div>
          <Toggle on={previewHint} onClick={() => setPreviewHint(!previewHint)} label="Показать с купленной подсказкой"></Toggle>
        </div>
      </div>
    </AdmShell>
  );
}

Object.assign(window, { StepEditor });
