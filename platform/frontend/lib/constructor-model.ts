/**
 * Конструктор v2 (workspace) model — ported from design/ctor2/store.jsx.
 *
 * The authoring shape (CtorStep) is editor-friendly (toggles, string coords);
 * stepToGameStep converts it to the canonical GameStep from shared-model, so
 * the builder preview, the test player and the published snapshot all flow
 * through the SAME production path (toDesignStep → StepView). What the author
 * sees in the preview is exactly what the player will render.
 *
 * Pure functions only — persistence takes an injectable storage so the model
 * stays testable in node.
 */
import type { GameStep, QuestSnapshot, Supporting } from './shared-model';

export type CtorTemplate =
  | 'start' | 'video' | 'task_no' | 'task_answer' | 'continue' | 'route_video' | 'congrats';

export type ComicRole = 'task' | 'character' | 'hint' | 'atmosphere';

export interface CtorStep {
  id: string;
  template: CtorTemplate;
  /** Служебное имя страницы (игрок не видит). */
  name: string;
  text: string;
  /** start: надзаголовок («Городской квест»). */
  kicker: string;
  /** congrats: заголовок финала. */
  title: string;
  /** task_answer: плейсхолдер поля ответа. */
  prompt: string;
  /** task_no: адрес и расстояние (строка с булавкой). */
  place: string;
  action: { desc: string; confirmLabel: string };
  allowNote: boolean;
  images: Partial<Record<ComicRole, string | null>>;
  video: { dur: string; label: string } | null;
  acceptable: string[];
  gift: { on: boolean; coins: number; narrative: string };
  hint: { on: boolean; cost: number; text: string };
  nav: { on: boolean; lat: string; lng: string; label: string };
}

export interface CtorQuestMeta {
  title: string;
  city: string;
  duration: string;
  cover: string | null;
  desc: string;
  price: number;
}

export interface CtorVersion {
  n: number;
  date: string;
  pages: number;
  size: string;
  live: boolean;
  attempts: number;
}

export interface CtorQuest {
  id: string;
  meta: CtorQuestMeta;
  steps: CtorStep[];
  versions: CtorVersion[];
  lastSaved: number | null;
}

export type CtorSelection =
  | { type: 'settings' }
  | { type: 'publish' }
  | { type: 'page'; id: string };

export interface WorkspaceState {
  ver: 1;
  screen: 'list' | 'builder';
  questId: string | null;
  sel: CtorSelection | null;
  quests: CtorQuest[];
}

export interface GateMessage {
  pageId: string | null;
  text: string;
}

export interface Gates {
  errors: GateMessage[];
  warnings: GateMessage[];
  perPage: Record<string, Array<{ kind: 'err' | 'warn'; text: string }>>;
  sizeMb: number;
  sizeLabel: string;
  imgs: number;
  vids: number;
}

export const CTOR_TEMPLATES: Array<{ key: CtorTemplate; name: string; desc: string; fill: string }> = [
  { key: 'start', name: 'Первый экран', desc: 'Обложка квеста: название, город, длительность.', fill: 'кнопка «начать квест», мета из настроек квеста' },
  { key: 'video', name: 'Приветственное видео', desc: 'Знакомство с автором или сюжетом через видео.', fill: 'видео-блок + кнопка «продолжить»' },
  { key: 'task_no', name: 'Задание без ответа', desc: 'Дойти до места, иногда выполнить действие. Подтверждение на честность.', fill: '«Я на месте», навигатор вкл, заметка разрешена' },
  { key: 'task_answer', name: 'Задание с ответом', desc: 'Вопрос с проверкой по списку ответов.', fill: 'поле ответа, подсказка 5 монет, подарок 5 монет' },
  { key: 'continue', name: 'Продолжить', desc: 'Развитие сюжета: диалог, факт, переход.', fill: 'кнопка «продолжить»' },
  { key: 'route_video', name: 'Видео маршрута', desc: 'Видео-навигация до следующей точки.', fill: 'видео-блок + навигатор + «в путь»' },
  { key: 'congrats', name: 'Поздравление', desc: 'Финал: бонус, итоги, оценка квеста.', fill: 'бонус +5 монет, встроенный блок оценки' },
];

export const TPL_BY_KEY = Object.fromEntries(CTOR_TEMPLATES.map((t) => [t.key, t])) as Record<
  CtorTemplate,
  (typeof CTOR_TEMPLATES)[number]
>;

export const COMIC_ROLES: Partial<Record<CtorTemplate, Array<{ key: ComicRole; label: string; req?: boolean }>>> = {
  task_no: [
    { key: 'task', label: 'задание', req: true },
    { key: 'character', label: 'персонаж' },
    { key: 'atmosphere', label: 'атмосфера' },
  ],
  task_answer: [
    { key: 'task', label: 'задание', req: true },
    { key: 'character', label: 'персонаж' },
    { key: 'hint', label: 'подсказка' },
    { key: 'atmosphere', label: 'атмосфера' },
  ],
  continue: [{ key: 'task', label: 'иллюстрация' }],
};

export function uid(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return 'p' + crypto.randomUUID().slice(0, 8);
  }
  return 'p' + Math.random().toString(36).slice(2, 10);
}

export function plural(n: number, one: string, few: string, many: string): string {
  const m = n % 10;
  const h = n % 100;
  return m === 1 && h !== 11 ? one : m >= 2 && m <= 4 && (h < 12 || h > 14) ? few : many;
}

export function fmtTime(ts: number | null): string | null {
  if (!ts) return null;
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/* ---------- Префиллы шаблонов (SPEC: Template presets) ---------- */

export function newStep(template: CtorTemplate): CtorStep {
  const s: CtorStep = {
    id: uid(),
    template,
    name: TPL_BY_KEY[template].name,
    text: '',
    kicker: '',
    title: '',
    prompt: '',
    place: '',
    action: { desc: '', confirmLabel: 'Я на месте' },
    allowNote: false,
    images: {},
    video: null,
    acceptable: [],
    gift: { on: false, coins: 5, narrative: '' },
    hint: { on: false, cost: 5, text: '' },
    nav: { on: false, lat: '', lng: '', label: '' },
  };
  if (template === 'start') s.kicker = 'Городской квест';
  if (template === 'video') s.video = { dur: '0:00', label: 'видео-приветствие' };
  if (template === 'route_video') {
    s.video = { dur: '0:00', label: 'видео маршрута' };
    s.nav.on = true;
  }
  if (template === 'task_no') {
    s.nav.on = true;
    s.allowNote = true;
  }
  if (template === 'task_answer') {
    s.prompt = 'Введите ответ';
    s.gift = { on: true, coins: 5, narrative: '' };
    s.hint = { on: true, cost: 5, text: '' };
  }
  if (template === 'congrats') s.title = 'Квест пройден!';
  return s;
}

export function newQuest(meta: Partial<CtorQuestMeta>): CtorQuest {
  return {
    id: 'q-' + uid(),
    meta: {
      title: meta.title?.trim() || 'Без названия',
      city: meta.city || '',
      duration: meta.duration || '',
      cover: meta.cover || null,
      desc: meta.desc || '',
      price: meta.price || 0,
    },
    steps: [newStep('start'), newStep('congrats')],
    versions: [],
    lastSaved: null,
  };
}

/* ---------- Гейты публикации (живой пересчёт по черновику) ---------- */

const isTaskTemplate = (t: CtorTemplate) => t === 'task_no' || t === 'task_answer';
const hasNumericCoords = (nav: CtorStep['nav']) =>
  Number.isFinite(parseFloat(nav.lat)) && Number.isFinite(parseFloat(nav.lng));

/** Грубая оценка веса медиа: data-URL считаем честно по base64, внешние пути — константой. */
function imageMb(src: string): number {
  if (src.startsWith('data:')) return (src.length * 3) / 4 / (1024 * 1024);
  return 0.35;
}

export function computeGates(quest: CtorQuest): Gates {
  const errors: GateMessage[] = [];
  const warnings: GateMessage[] = [];
  const perPage: Gates['perPage'] = {};
  const add = (pageId: string | null, kind: 'err' | 'warn', text: string) => {
    (kind === 'err' ? errors : warnings).push({ pageId, text });
    if (pageId) (perPage[pageId] = perPage[pageId] || []).push({ kind, text });
  };

  const steps = quest.steps;
  if (!steps.length || steps[0].template !== 'start') {
    add(null, 'err', 'Первая страница должна быть «Первый экран»');
  }
  if (!steps.some((s) => s.template === 'congrats')) {
    add(null, 'err', 'Нет терминальной страницы «Поздравление»');
  } else if (steps[steps.length - 1].template !== 'congrats') {
    add(null, 'warn', '«Поздравление» — не последняя страница');
  }

  steps.forEach((s, i) => {
    if (s.template === 'start' && i > 0) {
      add(s.id, 'err', `«${s.name}» — «Первый экран» может быть только первой страницей`);
    }
    if (isTaskTemplate(s.template) && !s.images.task) {
      add(s.id, 'err', `«${s.name}» — нет комикса «задание»`);
    }
    if (s.template === 'task_answer' && !s.acceptable.some((a) => a.trim())) {
      add(s.id, 'err', `«${s.name}» — список ответов пуст`);
    }
    if (s.nav.on && !hasNumericCoords(s.nav)) {
      add(s.id, 'err', `«${s.name}» — навигатор включён, координаты не заданы`);
    }
    if (s.template === 'task_answer' && s.hint.on && !s.hint.text.trim()) {
      add(s.id, 'warn', `«${s.name}» — подсказка платная, но без текста`);
    }
  });

  if (!quest.meta.cover) {
    add(null, 'warn', 'Нет обложки — карточка в магазине и «Первый экран» будут пустыми');
  }

  let imgs = 0;
  let vids = 0;
  let mb = 0.4;
  const countImage = (src: string | null | undefined) => {
    if (!src) return;
    imgs += 1;
    mb += imageMb(src);
  };
  steps.forEach((s) => {
    (Object.values(s.images) as Array<string | null | undefined>).forEach(countImage);
    if (s.video) {
      vids += 1;
      mb += 1.6;
    }
  });
  countImage(quest.meta.cover);

  const sizeLabel = mb.toFixed(1).replace('.', ',') + ' МБ';
  if (mb > 5) {
    add(null, 'warn', `Размер бандла ~${sizeLabel} — выше цели 5 МБ (сожмите изображения или видео)`);
  }

  return { errors, warnings, perPage, sizeMb: mb, sizeLabel, imgs, vids };
}

/* ---------- Сериализация черновика в канонический GameStep ---------- */

function navOf(s: CtorStep): Supporting['navigator'] {
  if (!s.nav.on || !hasNumericCoords(s.nav)) return null;
  return { lat: parseFloat(s.nav.lat), lng: parseFloat(s.nav.lng), label: s.nav.label || '' };
}

function giftOf(s: CtorStep): Supporting['gift'] {
  if (!s.gift.on || !(s.gift.coins > 0)) return null;
  return { coins: s.gift.coins, narrative_text: s.gift.narrative || '' };
}

/**
 * Editor step → canonical GameStep. Position is assigned by serializeDraft;
 * a single step maps with position null (preview use).
 */
export function stepToGameStep(s: CtorStep, meta: CtorQuestMeta): GameStep {
  const g: GameStep = {
    position: null,
    template: s.template,
    rich_content: { title: s.name, main_text: s.text },
    media: {
      task: s.images.task || null,
      character: s.images.character || null,
      hint: s.images.hint || null,
      atmosphere: s.images.atmosphere || null,
      video: s.video ? { duration_label: s.video.dur, caption: s.video.label } : null,
    },
    completion: { mode: 'physical' },
    supporting: {},
  };
  const sup = g.supporting as Supporting;
  const nav = navOf(s);
  const gift = giftOf(s);

  switch (s.template) {
    case 'start':
      g.rich_content = {
        title: meta.title,
        place_text: s.kicker,
        main_text: s.text,
        button_text: 'начать квест',
      };
      g.media.task = meta.cover;
      sup.is_start = true;
      break;
    case 'video':
    case 'route_video':
      g.rich_content.button_text = s.template === 'route_video' ? 'в путь' : 'продолжить';
      if (nav) sup.navigator = nav;
      break;
    case 'task_no':
      g.rich_content.place_text = s.place;
      g.completion = { mode: 'physical', allow_note: s.allowNote };
      sup.physical_action = { description: s.action.desc, confirm_label: s.action.confirmLabel || 'Я на месте' };
      if (nav) sup.navigator = nav;
      if (gift) sup.gift = gift;
      break;
    case 'task_answer':
      g.rich_content.question_prompt = s.prompt || 'Введите ответ';
      g.completion = { mode: 'answer', acceptable: s.acceptable.map((a) => a.trim()).filter(Boolean) };
      if (s.hint.on) sup.hint = { cost_coins: s.hint.cost, reveal_text: s.hint.text };
      if (gift) sup.gift = gift;
      if (nav) sup.navigator = nav;
      break;
    case 'continue':
      break;
    case 'congrats':
      g.rich_content.title = s.title || 'Квест пройден!';
      sup.terminal = true;
      break;
  }
  return g;
}

export function nextVersionNumber(quest: CtorQuest): number {
  return (quest.versions.length ? Math.max(...quest.versions.map((v) => v.n)) : 0) + 1;
}

/** Frozen snapshot of the draft — deep-cloned, versioned, positions sealed. */
export function serializeDraft(quest: CtorQuest): QuestSnapshot {
  const steps = quest.steps.map((s, i) => ({ ...stepToGameStep(s, quest.meta), position: i }));
  return {
    golden_id: quest.id,
    name: quest.meta.title,
    snapshot_version: nextVersionNumber(quest),
    steps: JSON.parse(JSON.stringify(steps)) as GameStep[],
  };
}

/* ---------- Структурные правки ---------- */

/**
 * Куда вставлять новую страницу: после выбранной, но не позже финального
 * «Поздравления» (вставляемое «Поздравление» ограничение не получает).
 */
export function insertionIndex(steps: CtorStep[], selectedId: string | null, template: CtorTemplate): number {
  const selIdx = selectedId ? steps.findIndex((s) => s.id === selectedId) : -1;
  let i = selIdx >= 0 ? selIdx + 1 : steps.length;
  const last = steps[steps.length - 1];
  if (i === steps.length && last && last.template === 'congrats' && template !== 'congrats') {
    i = steps.length - 1;
  }
  return i;
}

export function reorderSteps(steps: CtorStep[], from: number, to: number): CtorStep[] {
  if (from === to || from < 0 || to < 0 || from >= steps.length || to >= steps.length) return steps;
  const arr = [...steps];
  const [moved] = arr.splice(from, 1);
  arr.splice(to, 0, moved);
  return arr;
}

export function duplicateStep(steps: CtorStep[], id: string): { steps: CtorStep[]; newId: string | null } {
  const idx = steps.findIndex((s) => s.id === id);
  if (idx < 0) return { steps, newId: null };
  const copy: CtorStep = JSON.parse(JSON.stringify(steps[idx]));
  copy.id = uid();
  copy.name = steps[idx].name + ' (копия)';
  const arr = [...steps];
  arr.splice(idx + 1, 0, copy);
  return { steps: arr, newId: copy.id };
}

export function removeStep(steps: CtorStep[], id: string): { steps: CtorStep[]; nextSelectedId: string | null } {
  const idx = steps.findIndex((s) => s.id === id);
  if (idx < 0) return { steps, nextSelectedId: null };
  const neighbour = steps[idx + 1] || steps[idx - 1] || null;
  return { steps: steps.filter((s) => s.id !== id), nextSelectedId: neighbour ? neighbour.id : null };
}

/* ---------- Персистентность (черновики переживают перезагрузку) ---------- */

export const WORKSPACE_KEY = 'gq-ctor2:v1';

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function defaultStorage(): StorageLike | null {
  return typeof localStorage === 'undefined' ? null : localStorage;
}

export function loadWorkspace(storage: StorageLike | null = defaultStorage()): WorkspaceState {
  try {
    const raw = storage?.getItem(WORKSPACE_KEY);
    if (raw) {
      const s = JSON.parse(raw) as WorkspaceState;
      if (s && s.ver === 1 && Array.isArray(s.quests)) return s;
    }
  } catch {
    /* повреждённое состояние → seed */
  }
  return seedWorkspace();
}

/** @returns false при ошибке записи (квота localStorage) — UI показывает «не сохранено». */
export function saveWorkspace(state: WorkspaceState, storage: StorageLike | null = defaultStorage()): boolean {
  try {
    storage?.setItem(WORKSPACE_KEY, JSON.stringify(state));
    return true;
  } catch {
    return false;
  }
}

/* ---------- Демо-данные (из design/ctor2/store.jsx, картинки из /public) ---------- */

const IMG = {
  task: '/assets/img/church.jpg',
  character: '/assets/img/avatar-author.jpg',
  hint: '/assets/img/feature-group.jpg',
  atmosphere: '/assets/img/hero-main.png',
  cover: '/assets/img/quest-card.png',
};

function seedStep(template: CtorTemplate, patch: Partial<CtorStep>): CtorStep {
  return { ...newStep(template), ...patch };
}

export function seedWorkspace(): WorkspaceState {
  const q1: CtorQuest = {
    id: 'q-ironia',
    meta: {
      title: 'Ирония судьбы',
      city: 'Нови Сад',
      duration: '90 минут',
      cover: IMG.cover,
      desc: 'Городская прогулка по следам исторических личностей: церковные книги, кованые ограды и одно громкое имя в финале.',
      price: 990,
    },
    lastSaved: null,
    versions: [
      { n: 3, date: '02.05.2026', pages: 8, size: '4,8 МБ', live: true, attempts: 31 },
      { n: 2, date: '12.03.2026', pages: 8, size: '4,6 МБ', live: false, attempts: 3 },
    ],
    steps: [
      seedStep('start', { kicker: 'Городской квест', text: 'по следам исторических личностей' }),
      seedStep('video', {
        name: 'Приветственное видео',
        video: { dur: '0:48', label: 'видео-приветствие автора' },
        text: 'Здравствуйте! Я архивариус Николаевской церкви. Сто лет назад здесь оставил след человек, изменивший наше представление о Вселенной. Готовы пройти по его следам?',
      }),
      seedStep('continue', {
        name: 'Завязка',
        images: { task: IMG.task },
        text: '1913 год. Нови Сад. В церковной книге появляется запись о крещении двух мальчиков — Эдуарда и Альберта.\n\nИх мать — сербка Милева Марич. Об отце пока умолчим: вы сами назовёте его имя к концу прогулки.',
      }),
      seedStep('task_no', {
        name: 'Дойти до церкви',
        images: { task: IMG.task },
        text: 'Дойдите до Николаевской церкви — самой старой православной церкви города.',
        place: 'ул. Николаевска порта 2 · 400 м отсюда',
        action: { desc: 'Найдите кованую ограду у входа и прикоснитесь к холодному металлу — так здоровались с церковью сто лет назад.', confirmLabel: 'Я на месте, нашёл' },
        allowNote: true,
        nav: { on: true, lat: '45.2551', lng: '19.8451', label: 'Николаевская церковь' },
        gift: { on: true, coins: 3, narrative: 'За смелость и точность' },
      }),
      seedStep('task_answer', {
        name: 'Год освящения',
        images: { task: IMG.task, hint: IMG.hint },
        text: 'Взгляните на табличку над входом. В каком году храм был освящён после перестройки?',
        prompt: 'Введите год',
        acceptable: ['1730', 'в 1730', '1730 год'],
        gift: { on: true, coins: 5, narrative: 'Острый глаз!' },
        hint: { on: true, cost: 5, text: 'Цифры выбиты в каменной арке над дверью — две первые уже видны с дорожки.' },
      }),
      seedStep('route_video', {
        name: 'Маршрут к парку',
        video: { dur: '0:31', label: 'видео маршрута до парка' },
        text: 'Теперь — по Дунавской улице к городскому парку. По пути считайте кофейни: их тут больше, чем фонарей.',
        nav: { on: true, lat: '45.2552', lng: '19.8489', label: 'Дунавский парк' },
      }),
      seedStep('continue', {
        name: 'Диалог с архивариусом',
        images: { task: IMG.cover },
        text: '— Вот, спасибо, удружили! Что там у вас? Так, где у меня книга 1913 года была?\n\nДа тут одна запись всего: «Едуард и Алберт, крштени су по православном обреду…»\n\nПодождите, да их же мать та самая Милева. Ну и дела!',
      }),
      seedStep('congrats', {
        name: 'Поздравление',
        title: 'Квест пройден!',
        text: 'Имя отца мальчиков вы уже поняли сами: Альберт Эйнштейн. Ирония судьбы в том, что города, хранящие чьи-то следы, сами становятся частью истории.',
      }),
    ],
  };

  const q2: CtorQuest = {
    id: 'q-podzem',
    meta: {
      title: 'Подземелья Петроварадина',
      city: 'Нови Сад',
      duration: '2 часа',
      cover: IMG.task,
      desc: 'Крепость над Дунаем и 16 километров галерей под ней. Спускаемся по уровням — от часовой башни до четвёртого подземного.',
      price: 0,
    },
    lastSaved: null,
    versions: [{ n: 1, date: '20.04.2026', pages: 4, size: '2,3 МБ', live: true, attempts: 12 }],
    steps: [
      seedStep('start', { kicker: 'Квест-спуск', text: 'крепость, какой её не показывают туристам' }),
      seedStep('continue', {
        name: 'Пролог',
        images: { task: IMG.task },
        text: 'Петроварадинскую крепость строили 88 лет. Под ней — четыре уровня галерей, и карта самого нижнего утеряна до сих пор.',
      }),
      seedStep('task_answer', {
        name: 'Часы наоборот',
        images: { task: IMG.cover },
        text: 'Посмотрите на часовую башню. Какая стрелка на этих часах длиннее — часовая или минутная?',
        prompt: 'Введите ответ',
        acceptable: ['часовая', 'часовая стрелка'],
        gift: { on: true, coins: 5, narrative: 'Время здесь течёт иначе' },
        hint: { on: true, cost: 5, text: 'Рыбакам с Дуная важнее видеть часы издалека — минуты им ни к чему.' },
      }),
      seedStep('congrats', {
        name: 'Поздравление',
        title: 'Квест пройден!',
        text: 'Часовая длиннее минутной — чтобы время видели с реки. Крепость выдала вам одну из своих тайн; остальные ждут под землёй.',
      }),
    ],
  };

  return { ver: 1, screen: 'list', questId: null, sel: null, quests: [q1, q2] };
}
