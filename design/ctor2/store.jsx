// GEOHOD QUEST — конструктор v2: модель данных.
// Авторский шейп шага близок к плеерному GameStep; wspSerialize даёт
// в точности тот объект, который потребляют НАСТОЯЩИЕ компоненты плеера.

const WSP_KEY = "gq-ctor2-v1";

const WSP_DEMO_IMG = {
  task: "assets/img/church.jpg",
  character: "assets/img/avatar-author.jpg",
  hint: "assets/img/template-preview.png",
  atmosphere: "assets/img/mobile-hero.png",
  cover: "assets/img/quest-card.png",
};

const WSP_TEMPLATES = [
  { key: "start", name: "Первый экран", desc: "Обложка квеста: название, город, длительность.", fill: "кнопка «начать квест», мета из настроек квеста" },
  { key: "video", name: "Приветственное видео", desc: "Знакомство с автором или сюжетом через видео.", fill: "видео-блок + кнопка «продолжить»" },
  { key: "task_no", name: "Задание без ответа", desc: "Дойти до места, иногда выполнить действие. Подтверждение на честность.", fill: "«Я на месте», навигатор вкл, заметка разрешена" },
  { key: "task_answer", name: "Задание с ответом", desc: "Вопрос с проверкой по списку ответов.", fill: "поле ответа, подсказка 5 монет, подарок 5 монет" },
  { key: "continue", name: "Продолжить", desc: "Развитие сюжета: диалог, факт, переход.", fill: "кнопка «продолжить»" },
  { key: "route_video", name: "Видео маршрута", desc: "Видео-навигация до следующей точки.", fill: "видео-блок + навигатор + «в путь»" },
  { key: "congrats", name: "Поздравление", desc: "Финал: бонус, итоги, оценка квеста.", fill: "бонус +5 монет, встроенный блок оценки" },
];
const WSP_TPL_BY_KEY = Object.fromEntries(WSP_TEMPLATES.map((t) => [t.key, t]));

function wspUid() { return "p" + Math.random().toString(36).slice(2, 9); }

function wspPlural(n, a, b, c) {
  const m = n % 10, h = n % 100;
  return m === 1 && h !== 11 ? a : (m >= 2 && m <= 4 && (h < 12 || h > 14) ? b : c);
}

function wspFmtTime(ts) {
  if (!ts) return null;
  const d = new Date(ts);
  return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
}

/* ---------- Префиллы шаблонов (SPEC: Template presets) ---------- */
function wspNewStep(template) {
  const s = {
    id: wspUid(), template,
    name: WSP_TPL_BY_KEY[template].name,
    text: "", kicker: "", title: "", prompt: "", place: "",
    action: { desc: "", confirmLabel: "Я на месте" },
    allowNote: false,
    images: {},
    video: null,
    acceptable: [],
    gift: { on: false, coins: 5, narrative: "" },
    hint: { on: false, cost: 5, text: "" },
    nav: { on: false, lat: "", lng: "", label: "" },
  };
  if (template === "start") { s.kicker = "Городской квест"; }
  if (template === "video") { s.video = { dur: "0:00", label: "видео-приветствие" }; }
  if (template === "route_video") { s.video = { dur: "0:00", label: "видео маршрута" }; s.nav.on = true; }
  if (template === "task_no") { s.nav.on = true; s.allowNote = true; }
  if (template === "task_answer") {
    s.prompt = "Введите ответ";
    s.gift = { on: true, coins: 5, narrative: "" };
    s.hint = { on: true, cost: 5, text: "" };
  }
  if (template === "congrats") { s.title = "Квест пройден!"; }
  return s;
}

function wspNewQuest(meta) {
  return {
    id: wspUid(),
    meta: { title: meta.title || "Без названия", city: meta.city || "", duration: meta.duration || "", cover: meta.cover || null, desc: meta.desc || "", price: meta.price || 0 },
    steps: [wspNewStep("start"), wspNewStep("congrats")],
    versions: [],
    lastSaved: null,
  };
}

/* ---------- Гейты публикации (живой пересчёт по черновику) ---------- */
function wspGates(quest) {
  const errors = [], warnings = [], perPage = {};
  const add = (pageId, kind, text) => {
    (kind === "err" ? errors : warnings).push({ pageId, text });
    if (pageId) { (perPage[pageId] = perPage[pageId] || []).push({ kind, text }); }
  };
  const steps = quest.steps;
  if (!steps.length || steps[0].template !== "start") add(null, "err", "Первая страница должна быть «Первый экран»");
  if (!steps.some((s) => s.template === "congrats")) add(null, "err", "Нет терминальной страницы «Поздравление»");
  else if (steps[steps.length - 1].template !== "congrats") add(null, "warn", "«Поздравление» — не последняя страница");
  steps.forEach((s) => {
    const isTask = s.template === "task_no" || s.template === "task_answer";
    if (isTask && !(s.images && s.images.task)) add(s.id, "err", `«${s.name}» — нет комикса «задание»`);
    if (s.template === "task_answer" && !(s.acceptable || []).some((a) => a.trim())) add(s.id, "err", `«${s.name}» — список ответов пуст`);
    if (s.nav && s.nav.on && (!String(s.nav.lat).trim() || !String(s.nav.lng).trim())) add(s.id, "err", `«${s.name}» — навигатор включён, координаты не заданы`);
    if (s.template === "task_answer" && s.hint.on && !s.hint.text.trim()) add(s.id, "warn", `«${s.name}» — подсказка платная, но без текста`);
  });
  if (!quest.meta.cover) add(null, "warn", "Нет обложки — карточка в магазине и «Первый экран» будут пустыми");
  let imgs = 0, vids = 0;
  steps.forEach((s) => {
    imgs += Object.values(s.images || {}).filter(Boolean).length;
    if (s.video) vids++;
  });
  if (quest.meta.cover) imgs++;
  const mb = 0.4 + imgs * 0.35 + vids * 1.6;
  const size = mb.toFixed(1).replace(".", ",") + " МБ";
  if (mb > 5) add(null, "warn", `Размер бандла ~${size} — выше цели 5 МБ (сожмите изображения или видео)`);
  return { errors, warnings, perPage, size, imgs, vids };
}

/* ---------- Сериализация черновика в плеерный формат ---------- */
function wspNavOf(s) {
  if (!s.nav || !s.nav.on) return null;
  return { lat: s.nav.lat, lng: s.nav.lng, label: s.nav.label || "" };
}
function wspGiftOf(s) {
  if (!s.gift || !s.gift.on || !(+s.gift.coins > 0)) return null;
  return { coins: +s.gift.coins, narrative: s.gift.narrative || "" };
}

function wspToPlayerStep(s, quest) {
  const m = quest.meta;
  const base = { id: s.id, template: s.template, name: s.name };
  const img = (s.images && s.images.task) || null;
  switch (s.template) {
    case "start":
      return { ...base, kicker: s.kicker, title: m.title, text: s.text, image: m.cover, imageLabel: "обложка квеста" };
    case "video":
    case "route_video":
      return { ...base, video: { poster: null, dur: (s.video && s.video.dur) || "0:00", label: (s.video && s.video.label) || "видео" }, text: s.text, nav: wspNavOf(s) };
    case "task_no":
      return {
        ...base, image: img, imageLabel: "комикс «задание»", text: s.text,
        place: s.place || null,
        action: (s.action && (s.action.desc || s.action.confirmLabel)) ? { desc: s.action.desc, confirmLabel: s.action.confirmLabel || "Выполнено" } : null,
        allowNote: !!s.allowNote, nav: wspNavOf(s), gift: wspGiftOf(s),
      };
    case "task_answer":
      return {
        ...base, image: img, imageLabel: "комикс «задание»", text: s.text,
        prompt: s.prompt || "Введите ответ",
        acceptable: (s.acceptable || []).map((a) => a.trim()).filter(Boolean),
        gift: wspGiftOf(s),
        hint: s.hint && s.hint.on ? { cost: +s.hint.cost || 0, text: s.hint.text, imageLabel: "комикс-подсказка" } : null,
        nav: wspNavOf(s),
      };
    case "continue":
      return { ...base, image: img, imageLabel: "иллюстрация", text: s.text };
    default: // congrats
      return { ...base, title: s.title || "Квест пройден!", text: s.text };
  }
}

function wspSerialize(quest) {
  const m = quest.meta;
  return {
    title: m.title, city: m.city || "—", duration: m.duration || "—",
    completionBonus: 5,
    steps: quest.steps.map((s) => wspToPlayerStep(s, quest)),
  };
}

/* ---------- Демо-данные ---------- */
function wspSeed() {
  const st = (tpl, patch) => Object.assign(wspNewStep(tpl), patch);
  const q1 = {
    id: "q-ironia",
    meta: { title: "Ирония судьбы", city: "Нови Сад", duration: "90 минут", cover: WSP_DEMO_IMG.cover, desc: "Городская прогулка по следам исторических личностей: церковные книги, кованые ограды и одно громкое имя в финале.", price: 990 },
    lastSaved: null,
    versions: [
      { n: 3, date: "02.05.2026", pages: 8, size: "4,8 МБ", live: true, attempts: 31 },
      { n: 2, date: "12.03.2026", pages: 8, size: "4,6 МБ", live: false, attempts: 3 },
    ],
    steps: [
      st("start", { name: "Первый экран", kicker: "Городской квест", text: "по следам исторических личностей" }),
      st("video", { name: "Приветственное видео", video: { dur: "0:48", label: "видео-приветствие автора" }, text: "Здравствуйте! Я архивариус Николаевской церкви. Сто лет назад здесь оставил след человек, изменивший наше представление о Вселенной. Готовы пройти по его следам?" }),
      st("continue", { name: "Завязка", images: { task: WSP_DEMO_IMG.task }, text: "1913 год. Нови Сад. В церковной книге появляется запись о крещении двух мальчиков — Эдуарда и Альберта.\n\nИх мать — сербка Милева Марич. Об отце пока умолчим: вы сами назовёте его имя к концу прогулки." }),
      st("task_no", { name: "Дойти до церкви", text: "Дойдите до Николаевской церкви — самой старой православной церкви города.", place: "ул. Николаевска порта 2 · 400 м отсюда", action: { desc: "Найдите кованую ограду у входа и прикоснитесь к холодному металлу — так здоровались с церковью сто лет назад.", confirmLabel: "Я на месте, нашёл" }, allowNote: true, nav: { on: true, lat: "45.2551", lng: "19.8451", label: "Николаевская церковь" }, gift: { on: true, coins: 3, narrative: "За смелость и точность" } }),
      st("task_answer", { name: "Год освящения", images: { task: WSP_DEMO_IMG.task }, text: "Взгляните на табличку над входом. В каком году храм был освящён после перестройки?", prompt: "Введите год", acceptable: ["1730", "в 1730", "1730 год"], gift: { on: true, coins: 5, narrative: "Острый глаз!" }, hint: { on: true, cost: 5, text: "Цифры выбиты в каменной арке над дверью — две первые уже видны с дорожки." } }),
      st("route_video", { name: "Маршрут к парку", video: { dur: "0:31", label: "видео маршрута до парка" }, text: "Теперь — по Дунавской улице к городскому парку. По пути считайте кофейни: их тут больше, чем фонарей.", nav: { on: true, lat: "45.2552", lng: "19.8489", label: "Дунавский парк" } }),
      st("continue", { name: "Диалог с архивариусом", images: { task: WSP_DEMO_IMG.cover }, text: "— Вот, спасибо, удружили! Что там у вас? Так, где у меня книга 1913 года была?\n\nДа тут одна запись всего: «Едуард и Алберт, крштени су по православном обреду…»\n\nПодождите, да их же мать та самая Милева. Ну и дела!" }),
      st("congrats", { name: "Поздравление", title: "Квест пройден!", text: "Имя отца мальчиков вы уже поняли сами: Альберт Эйнштейн. Ирония судьбы в том, что города, хранящие чьи-то следы, сами становятся частью истории." }),
    ],
  };
  const q2 = {
    id: "q-podzem",
    meta: { title: "Подземелья Петроварадина", city: "Нови Сад", duration: "2 часа", cover: WSP_DEMO_IMG.task, desc: "Крепость над Дунаем и 16 километров галерей под ней. Спускаемся по уровням — от часовой башни до четвёртого подземного.", price: 0 },
    lastSaved: null,
    versions: [{ n: 1, date: "20.04.2026", pages: 4, size: "2,3 МБ", live: true, attempts: 12 }],
    steps: [
      st("start", { name: "Первый экран", kicker: "Квест-спуск", text: "крепость, какой её не показывают туристам" }),
      st("continue", { name: "Пролог", images: { task: WSP_DEMO_IMG.task }, text: "Петроварадинскую крепость строили 88 лет. Под ней — четыре уровня галерей, и карта самого нижнего утеряна до сих пор." }),
      st("task_answer", { name: "Часы наоборот", images: { task: WSP_DEMO_IMG.cover }, text: "Посмотрите на часовую башню. Какая стрелка на этих часах длиннее — часовая или минутная?", prompt: "Введите ответ", acceptable: ["часовая", "часовая стрелка"], gift: { on: true, coins: 5, narrative: "Время здесь течёт иначе" }, hint: { on: true, cost: 5, text: "Рыбакам с Дуная важнее видеть часы издалека — минуты им ни к чему." } }),
      st("congrats", { name: "Поздравление", title: "Квест пройден!", text: "Часовая длиннее минутной — чтобы время видели с реки. Крепость выдала вам одну из своих тайн; остальные ждут под землёй." }),
    ],
  };
  return { ver: 1, screen: "list", questId: null, sel: null, quests: [q1, q2] };
}

/* ---------- Персистентность (черновики переживают перезагрузку) ---------- */
function wspLoad() {
  try {
    const s = JSON.parse(localStorage.getItem(WSP_KEY));
    if (s && s.ver === 1 && Array.isArray(s.quests)) return s;
  } catch (e) { /* повреждённое состояние → seed */ }
  return wspSeed();
}
function wspSave(s) {
  try { localStorage.setItem(WSP_KEY, JSON.stringify(s)); } catch (e) { /* квота */ }
}

Object.assign(window, {
  WSP_KEY, WSP_DEMO_IMG, WSP_TEMPLATES, WSP_TPL_BY_KEY,
  wspUid, wspPlural, wspFmtTime, wspNewStep, wspNewQuest,
  wspGates, wspSerialize, wspSeed, wspLoad, wspSave,
});
