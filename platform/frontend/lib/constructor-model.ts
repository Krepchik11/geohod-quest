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

/** Подарок за шаг-задание фиксирован платформой: всегда включён, всегда 5 монет. */
export const GIFT_COINS = 5;

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
  action: { desc: string; confirmLabel: string };
  /** Единственное изображение страницы (4:3, ≤100 КБ — контракт пайплайна загрузки). */
  image: string | null;
  video: { dur: string; label: string } | null;
  acceptable: string[];
  gift: { narrative: string };
  /** Подсказка с тумблером (по умолчанию включена); продаётся, когда включена
   *  и есть текст и/или изображение. */
  hint: { on: boolean; cost: number; text: string; image: string | null };
  /**
   * «Адрес и расстояние» — необязательный блок точки. Название и расстояние
   * складываются в строку с булавкой на странице; координаты (формат Google
   * Maps: «45.2651, 19.8656») делают эту строку кликабельной — открывают
   * системные карты. Заменяет прежние раздельные «Адрес» и «Навигатор».
   */
  address: { on: boolean; name: string; distance: string; coords: string };
}

/** Сложность квеста — закрытый набор (зеркалит backend COMPLEXITIES). */
export type CtorComplexity = 'low' | 'medium' | 'high';
/** Аудитория квеста — закрытый набор (зеркалит backend AGE_TARGETS). */
export type CtorAgeTarget = 'kids' | 'everyone' | '18plus';

export const DEFAULT_COMPLEXITY: CtorComplexity = 'medium';
export const DEFAULT_AGE_TARGET: CtorAgeTarget = 'everyone';

export const COMPLEXITY_OPTIONS: Array<{ key: CtorComplexity; label: string }> = [
  { key: 'low', label: 'Низкая' },
  { key: 'medium', label: 'Средняя' },
  { key: 'high', label: 'Высокая' },
];
export const AGE_TARGET_OPTIONS: Array<{ key: CtorAgeTarget; label: string }> = [
  { key: 'kids', label: 'Для детей' },
  { key: 'everyone', label: 'Для всех' },
  { key: '18plus', label: '18+' },
];
export const COMPLEXITY_LABEL = Object.fromEntries(
  COMPLEXITY_OPTIONS.map((o) => [o.key, o.label]),
) as Record<CtorComplexity, string>;
export const AGE_TARGET_LABEL = Object.fromEntries(
  AGE_TARGET_OPTIONS.map((o) => [o.key, o.label]),
) as Record<CtorAgeTarget, string>;

/** Стартовые подсказки для собственных тегов (теги — свободные строки). */
export const SUGGESTED_TAGS = ['хоррор', 'научный', 'исторический', 'юмор', 'приключения'];

const isComplexity = (v: unknown): v is CtorComplexity =>
  COMPLEXITY_OPTIONS.some((o) => o.key === v);
const isAgeTarget = (v: unknown): v is CtorAgeTarget =>
  AGE_TARGET_OPTIONS.some((o) => o.key === v);

/** Теги из недоверенного тела: только непустые строки, trim, дедуп с сохранением порядка. */
function sanitizeTags(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const t of v) {
    if (typeof t !== 'string') continue;
    const tag = t.trim();
    if (tag && !out.includes(tag)) out.push(tag);
  }
  return out;
}

export interface CtorQuestMeta {
  title: string;
  city: string;
  duration: string;
  cover: string | null;
  desc: string;
  price: number;
  /** Marketing padding added to the real completions for the public players
   *  counter (store card / product page). 0 = show only real completions. */
  playersBonus: number;
  complexity: CtorComplexity;
  ageTarget: CtorAgeTarget;
  /** Собственные теги автора (свободные строки, без дублей). */
  tags: string[];
  /** Универсальный ответ квеста: принимается на любом шаге с вопросом.
   *  Пустая строка = выключен (в снапшот не попадает). */
  universalAnswer: string;
  /** Точка старта квеста одной строкой (формат Google Maps, как у адреса шага):
   *  координаты кнопки «Место старта» в магазине. Пустая строка = точки нет. */
  startCoords: string;
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

export interface GateMessage {
  pageId: string | null;
  text: string;
  /** Machine key of the offending control — lets «Исправить →» focus it (§9.2). */
  field?: GateField;
}

/** Controls a gate failure can point at inside the page editor / settings. */
export type GateField = 'image' | 'answers' | 'address' | 'hint' | 'cover' | 'start';

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
  { key: 'task_no', name: 'Задание без ответа', desc: 'Дойти до места, иногда выполнить действие. Подтверждение на честность.', fill: '«Я на месте», подарок 5 монет' },
  { key: 'task_answer', name: 'Задание с ответом', desc: 'Вопрос с проверкой по списку ответов.', fill: 'поле ответа, подсказка 5 монет, подарок 5 монет' },
  { key: 'continue', name: 'Продолжить', desc: 'Развитие сюжета: диалог, факт, переход.', fill: 'кнопка «продолжить»' },
  { key: 'route_video', name: 'Видео маршрута', desc: 'Видео-навигация до следующей точки.', fill: 'видео-блок + «в путь»' },
  { key: 'congrats', name: 'Поздравление', desc: 'Финал: бонус, итоги, оценка квеста.', fill: 'бонус +5 монет, встроенный блок оценки' },
];

export const TPL_BY_KEY = Object.fromEntries(CTOR_TEMPLATES.map((t) => [t.key, t])) as Record<
  CtorTemplate,
  (typeof CTOR_TEMPLATES)[number]
>;

/** Шаблоны со своим изображением страницы (обязательно для заданий). */
export const IMAGE_TEMPLATES: Partial<Record<CtorTemplate, { label: string; req?: boolean }>> = {
  task_no: { label: 'изображение', req: true },
  task_answer: { label: 'изображение', req: true },
  continue: { label: 'иллюстрация' },
};

/**
 * Координаты одним полем — формат копипасты из Google Maps:
 * «45.2651377918879, 19.865664144668212». Допускаем произвольные пробелы
 * вокруг запятой; валидируем диапазоны широты/долготы.
 */
export function parseCoords(input: string): { lat: number; lng: number } | null {
  const m = /^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/.exec(input);
  if (!m) return null;
  const lat = parseFloat(m[1]);
  const lng = parseFloat(m[2]);
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  return { lat, lng };
}

/** Автор что-то ввёл в поле точки старта, но это не координаты. Один источник
 *  правила и текста для гейта публикации и для подписи под самим инпутом —
 *  иначе чек-лист и настройки разойдутся в пороге или в формулировке. */
export function badStartCoords(meta: CtorQuestMeta): boolean {
  return !!meta.startCoords.trim() && !parseCoords(meta.startCoords);
}

export const BAD_START_COORDS_TEXT = 'Точка старта: координаты не распознаны (формат «45.2651, 19.8656»)';

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
    action: { desc: '', confirmLabel: 'Я на месте' },
    image: null,
    video: null,
    acceptable: [],
    gift: { narrative: '' },
    hint: { on: true, cost: 5, text: '', image: null },
    address: { on: false, name: '', distance: '', coords: '' },
  };
  if (template === 'start') s.kicker = 'Городской квест';
  if (template === 'video') s.video = { dur: '0:00', label: 'видео-приветствие' };
  if (template === 'route_video') {
    s.video = { dur: '0:00', label: 'видео маршрута' };
  }
  if (template === 'task_answer') {
    s.prompt = 'Введите ответ';
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
      playersBonus: meta.playersBonus || 0,
      complexity: meta.complexity || DEFAULT_COMPLEXITY,
      ageTarget: meta.ageTarget || DEFAULT_AGE_TARGET,
      tags: meta.tags || [],
      universalAnswer: meta.universalAnswer || '',
      startCoords: meta.startCoords || '',
    },
    steps: [newStep('start'), newStep('congrats')],
    versions: [],
    lastSaved: null,
  };
}

/**
 * Create/save payload for the constructor API: the denormalized list columns
 * (name, cover, steps, attributes — the dashboard filters on them server-side
 * of the body) + the full opaque body. One builder for every call site so the
 * columns can never drift from the body.
 */
export function questUpsert(q: CtorQuest): {
  name: string;
  cover: string | null;
  steps_count: number;
  complexity: string;
  age_target: string;
  tags: string[];
  body: CtorQuest;
} {
  return {
    name: q.meta.title,
    cover: q.meta.cover,
    steps_count: q.steps.length,
    complexity: q.meta.complexity,
    age_target: q.meta.ageTarget,
    tags: q.meta.tags,
    body: q,
  };
}

/**
 * Deep copy of a quest as a fresh draft: new id, retitled «(копия)», no published
 * versions, never-saved. Duplication is a client operation (the server stores the
 * body opaquely), so the copy semantics live in one place next to {@link newQuest}.
 */
export function duplicateQuest(src: CtorQuest, newId: string): CtorQuest {
  const copy: CtorQuest = JSON.parse(JSON.stringify(src));
  copy.id = newId;
  copy.meta = { ...copy.meta, title: `${src.meta.title} (копия)` };
  copy.versions = [];
  copy.lastSaved = null;
  return copy;
}

/* ---------- Миграция старых тел черновиков ---------- */

/** Дособерём legacy-поля старого шага (image-роли, фикс-подарок, раздельные
 *  «Адрес»/«Навигатор» → «Адрес и расстояние», подсказка с тумблером). */
interface LegacyStepFields {
  images?: Partial<Record<'task' | 'character' | 'hint' | 'atmosphere', string | null>>;
  gift?: { narrative?: string };
  place?: string;
  nav?: { on?: boolean; coords?: string; lat?: string; lng?: string; label?: string };
  hint?: { on?: boolean; cost?: number; text?: string; image?: string | null };
  allowNote?: boolean;
}

/**
 * Прежний (выводной) источник «Места старта» — первый навигатор СНАПШОТА, ровно
 * то, что магазин читает у тел без поля в настройках. Считаем через
 * stepToGameStep, а не по s.address: адрес включён не на всех шаблонах попадает
 * в навигатор (см. switch там), и правило «первая точка» обязано совпадать с
 * тем, что реально опубликовано, иначе перенос сдвинет кнопку на другую точку.
 */
function firstSnapshotPoint(steps: CtorStep[], meta: CtorQuestMeta): string {
  for (const s of steps) {
    const nav = stepToGameStep(s, meta).supporting?.navigator;
    if (nav) return `${nav.lat}, ${nav.lng}`;
  }
  return '';
}

/**
 * Единственная точка входа серверного тела в редактор. Сервер хранит тело
 * опа́ково и round-trip'ит как есть, поэтому старые черновики приходят в
 * прежней форме (images-роли, gift-тумблер, nav.lat/lng/label) — приводим к
 * текущей. Идемпотентна для тел текущей формы.
 */
export function migrateQuest(body: unknown, serverId: string): CtorQuest | null {
  if (!body || typeof body !== 'object') return null;
  const raw = body as CtorQuest;
  if (!Array.isArray(raw.steps) || !raw.meta) return null;
  const steps = raw.steps.map((step) => {
    const s = { ...step };
    const legacy = step as CtorStep & LegacyStepFields;
    if (s.image === undefined) {
      const img = legacy.images;
      s.image = img?.task ?? img?.character ?? img?.hint ?? img?.atmosphere ?? null;
    }
    delete (s as LegacyStepFields).images;
    s.gift = { narrative: legacy.gift?.narrative ?? '' };
    // Тумблер подсказки: отсутствие в старом теле = включена (текст/изображение
    // сохраняем всегда — данные не теряются, продажу решает тумблер + контент).
    s.hint = {
      on: legacy.hint?.on ?? true,
      cost: legacy.hint?.cost ?? 5,
      text: legacy.hint?.text ?? '',
      image: legacy.hint?.image ?? null,
    };
    delete (s as LegacyStepFields).allowNote;
    // Раздельные «Адрес» (place) и «Навигатор» (nav: coords или lat/lng+label)
    // сливаются в один блок «Адрес и расстояние». Название = прежний адрес, при
    // его отсутствии — подпись точки навигатора; расстояние отдельного поля не
    // имело — остаётся частью названия.
    if (s.address === undefined) {
      const lat = legacy.nav?.lat?.trim() || '';
      const lng = legacy.nav?.lng?.trim() || '';
      const name = legacy.place || legacy.nav?.label || '';
      s.address = {
        // Старый адрес показывался всегда — блок включается и при выключенном
        // навигаторе, чтобы текст не пропал со страницы (координаты допросит гейт).
        on: !!legacy.nav?.on || !!name.trim(),
        name,
        distance: '',
        coords: legacy.nav?.coords ?? (lat && lng ? `${lat}, ${lng}` : ''),
      };
    }
    delete (s as LegacyStepFields).place;
    delete (s as LegacyStepFields).nav;
    return s;
  });
  // Тела, сохранённые до появления маркетингового счётчика игроков, не имеют
  // meta.playersBonus — нормализуем к 0, чтобы поле в настройках было управляемым.
  // Атрибуты (сложность/возраст/теги) появились позже: отсутствующие или
  // невалидные значения приводим к нейтральным, не доверяя хранимому телу.
  const meta = {
    ...raw.meta,
    playersBonus: raw.meta.playersBonus ?? 0,
    complexity: isComplexity(raw.meta.complexity) ? raw.meta.complexity : DEFAULT_COMPLEXITY,
    ageTarget: isAgeTarget(raw.meta.ageTarget) ? raw.meta.ageTarget : DEFAULT_AGE_TARGET,
    tags: sanitizeTags(raw.meta.tags),
    // Тела до появления универсального ответа поля не имеют — нормализуем к
    // пустой строке (= выключен), чтобы инпут в настройках был управляемым.
    universalAnswer: typeof raw.meta.universalAnswer === 'string' ? raw.meta.universalAnswer : '',
    // До появления квестового поля магазин выводил «Место старта» из первой точки
    // шага — переносим её в поле, иначе первая же перепубликация старого черновика
    // молча убрала бы кнопку. Только при ОТСУТСТВИИ ключа: пустая строка в теле —
    // осознанный выбор автора, его не перетираем.
    startCoords:
      typeof raw.meta.startCoords === 'string'
        ? raw.meta.startCoords
        : firstSnapshotPoint(steps, raw.meta),
  };
  // Гарантируем согласованность id тела с серверным id (на случай рассинхрона).
  return { ...raw, meta, steps, id: serverId };
}

/* ---------- Гейты публикации (живой пересчёт по черновику) ---------- */

const isTaskTemplate = (t: CtorTemplate) => t === 'task_no' || t === 'task_answer';

/** Грубая оценка веса медиа: data-URL считаем честно по base64, внешние пути — константой. */
function imageMb(src: string): number {
  if (src.startsWith('data:')) return (src.length * 3) / 4 / (1024 * 1024);
  return 0.35;
}

export function computeGates(quest: CtorQuest): Gates {
  const errors: GateMessage[] = [];
  const warnings: GateMessage[] = [];
  const perPage: Gates['perPage'] = {};
  const add = (pageId: string | null, kind: 'err' | 'warn', text: string, field?: GateField) => {
    (kind === 'err' ? errors : warnings).push({ pageId, text, field });
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
    if (isTaskTemplate(s.template) && !s.image) {
      add(s.id, 'err', `«${s.name}» — нет изображения страницы`, 'image');
    }
    if (s.template === 'task_answer' && !s.acceptable.some((a) => a.trim())) {
      add(s.id, 'err', `«${s.name}» — список ответов пуст`, 'answers');
    }
    if (s.address.on && !s.address.name.trim()) {
      add(s.id, 'err', `«${s.name}» — адрес включён, название не задано`, 'address');
    }
    if (s.address.on && !parseCoords(s.address.coords)) {
      add(s.id, 'err', `«${s.name}» — адрес включён, координаты не заданы`, 'address');
    }
    if (s.template === 'task_answer' && s.hint.on && !s.hint.text.trim() && !s.hint.image) {
      add(s.id, 'warn', `«${s.name}» — нет подсказки (текста или изображения): после 2-й ошибки игроку нечего будет купить`, 'hint');
    }
  });

  if (!quest.meta.cover) {
    add(null, 'warn', 'Нет обложки — карточка в магазине и «Первый экран» будут пустыми', 'cover');
  }

  // Точка старта: пусто — кнопки в магазине просто не будет (предупреждение);
  // введено, но не разобрано — ошибка, иначе набранное автором молча пропадёт.
  if (!quest.meta.startCoords.trim()) {
    add(null, 'warn', 'Не задана точка старта — на странице квеста не будет кнопки «Место старта»', 'start');
  } else if (badStartCoords(quest.meta)) {
    add(null, 'err', BAD_START_COORDS_TEXT, 'start');
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
    countImage(s.image);
    countImage(s.hint.image);
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
  if (!s.address.on) return null;
  const c = parseCoords(s.address.coords);
  // The address name doubles as the map point label.
  return c ? { lat: c.lat, lng: c.lng, label: s.address.name.trim() } : null;
}

/** Строка с булавкой на странице: «название · расстояние» (включённый блок). */
function placeTextOf(s: CtorStep): string {
  if (!s.address.on) return '';
  return [s.address.name, s.address.distance].map((t) => t.trim()).filter(Boolean).join(' · ');
}

function giftOf(s: CtorStep): Supporting['gift'] {
  return { coins: GIFT_COINS, narrative_text: s.gift.narrative || '' };
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
      task: s.image || null,
      character: null,
      hint: null,
      atmosphere: null,
      video: s.video ? { duration_label: s.video.dur, caption: s.video.label } : null,
    },
    completion: { mode: 'physical' },
    supporting: {},
  };
  const sup = g.supporting as Supporting;
  const nav = navOf(s);

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
      g.rich_content.place_text = placeTextOf(s);
      if (nav) sup.navigator = nav;
      break;
    case 'task_no':
      g.rich_content.place_text = placeTextOf(s);
      sup.physical_action = { description: s.action.desc, confirm_label: s.action.confirmLabel || 'Я на месте' };
      if (nav) sup.navigator = nav;
      sup.gift = giftOf(s);
      break;
    case 'task_answer':
      g.rich_content.place_text = placeTextOf(s);
      g.rich_content.question_prompt = s.prompt || 'Введите ответ';
      g.completion = { mode: 'answer', acceptable: s.acceptable.map((a) => a.trim()).filter(Boolean) };
      // Подсказка продаётся, когда включена и есть контент; изображение едет ролью media.hint.
      if (s.hint.on && (s.hint.text.trim() || s.hint.image)) {
        sup.hint = { cost_coins: s.hint.cost, reveal_text: s.hint.text };
        g.media.hint = s.hint.image;
      }
      sup.gift = giftOf(s);
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

/** Frozen snapshot of the draft — deep-cloned, versioned, positions sealed. The
 *  store-card city/duration are frozen in too (when set), so the player renders the
 *  real place/duration instead of a hardcoded default. The quest-wide universal
 *  answer freezes alongside them (trimmed; blank = the quest has none).
 *
 *  `start_point` is written on EVERY snapshot (null = the author set none) —
 *  see its declaration on QuestSnapshot for why presence is load-bearing. */
export function serializeDraft(quest: CtorQuest): QuestSnapshot {
  const steps = quest.steps.map((s, i) => ({ ...stepToGameStep(s, quest.meta), position: i }));
  const city = quest.meta.city.trim();
  const duration = quest.meta.duration.trim();
  const universalAnswer = quest.meta.universalAnswer.trim();
  return {
    golden_id: quest.id,
    name: quest.meta.title,
    snapshot_version: nextVersionNumber(quest),
    steps: JSON.parse(JSON.stringify(steps)) as GameStep[],
    start_point: parseCoords(quest.meta.startCoords),
    ...(city ? { city } : {}),
    ...(duration ? { duration } : {}),
    ...(universalAnswer ? { universal_answer: universalAnswer } : {}),
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
