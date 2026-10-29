/**
 * Плитки квестов в конструкторе (флаг ctor_tiles) — чистые правила списка:
 * вкладки статусов, «Требуют внимания», поиск, город, сортировка и подписи.
 * Экран (app/quest-editor/QuestTiles.tsx) только рисует то, что решено здесь.
 */
import type { ConstructorQuestWire, CtorStatus } from './api';
import { formatNumber, plural } from './ru';

export type TileTab = 'all' | CtorStatus | 'attention';
export type TileSort = 'updated' | 'players' | 'rating' | 'name';
export type TileView = 'tiles' | 'rows';

export const TILE_TABS: ReadonlyArray<{ key: TileTab; label: string }> = [
  { key: 'all', label: 'Все' },
  { key: 'published', label: 'В магазине' },
  { key: 'test', label: 'Тест' },
  { key: 'draft', label: 'Черновики' },
  { key: 'attention', label: 'Требуют внимания' },
];

export const TILE_SORTS: ReadonlyArray<{ key: TileSort; label: string }> = [
  { key: 'updated', label: 'Недавно изменённые' },
  { key: 'players', label: 'Больше игроков' },
  { key: 'rating', label: 'Выше рейтинг' },
  { key: 'name', label: 'По названию' },
];

/** Что ждёт действия автора — плашка на обложке и вкладка «Требуют внимания». */
export type TileAction =
  | { kind: 'changes'; next: number }
  | { kind: 'ready' }
  | null;

/**
 * Правки, которые ещё не дошли до игроков (квест в магазине или в тесте), и
 * черновик, прошедший все проверки. Черновик с ошибками — обычная работа, а
 * неизвестное (нет отпечатка или сводки) — не повод звать автора.
 */
export function tileAction(q: ConstructorQuestWire): TileAction {
  if (q.status !== 'draft' && q.published_version != null && q.unpublished_changes === true) {
    return { kind: 'changes', next: q.published_version + 1 };
  }
  if (q.status === 'draft' && q.gate_errors === 0) return { kind: 'ready' };
  return null;
}

export function inTab(q: ConstructorQuestWire, tab: TileTab): boolean {
  if (tab === 'all') return true;
  if (tab === 'attention') return tileAction(q) !== null;
  return q.status === tab;
}

export function tabCounts(quests: readonly ConstructorQuestWire[]): Record<TileTab, number> {
  const out: Record<TileTab, number> = { all: 0, published: 0, test: 0, draft: 0, attention: 0 };
  for (const q of quests) {
    out.all += 1;
    out[q.status] += 1;
    if (tileAction(q)) out.attention += 1;
  }
  return out;
}

/** Города квестов автора для фильтра: самые частые сверху, затем по алфавиту. */
export function tileCities(quests: readonly ConstructorQuestWire[]): Array<{ name: string; count: number }> {
  const counts = new Map<string, number>();
  for (const q of quests) if (q.city) counts.set(q.city, (counts.get(q.city) ?? 0) + 1);
  return [...counts]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'ru'));
}

const SORTERS: Record<TileSort, (a: ConstructorQuestWire, b: ConstructorQuestWire) => number> = {
  updated: (a, b) => b.updated_at - a.updated_at,
  players: (a, b) => b.players - a.players,
  // Квест без оценок — ниже любого оценённого; при равенстве — больше оценок выше.
  rating: (a, b) =>
    (b.rating_count ? b.rating_avg : -1) - (a.rating_count ? a.rating_avg : -1) ||
    b.rating_count - a.rating_count,
  name: (a, b) => a.name.localeCompare(b.name, 'ru'),
};

export interface TileFilters {
  tab: TileTab;
  search: string;
  city: string;
  sort: TileSort;
}

/** Видимые плитки: вкладка, город, поиск по названию, городу и тегам; сортировка. */
export function visibleTiles(
  quests: readonly ConstructorQuestWire[],
  f: TileFilters,
): ConstructorQuestWire[] {
  const s = f.search.trim().toLowerCase();
  return quests
    .filter(
      (q) =>
        inTab(q, f.tab) &&
        (!f.city || q.city === f.city) &&
        (!s ||
          q.name.toLowerCase().includes(s) ||
          (q.city ?? '').toLowerCase().includes(s) ||
          q.tags.some((t) => t.toLowerCase().includes(s))),
    )
    .sort((a, b) => SORTERS[f.sort](a, b) || a.name.localeCompare(b.name, 'ru'));
}

/** «сегодня», «вчера», «3 дня назад», «2 недели назад», «5 месяцев назад». */
export function editedAgo(unixSecs: number, nowMs: number): string {
  if (!unixSecs) return '';
  const day = 86_400_000;
  const startOf = (ms: number) => {
    const d = new Date(ms);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  };
  const days = Math.max(0, Math.round((startOf(nowMs) - startOf(unixSecs * 1000)) / day));
  if (days === 0) return 'сегодня';
  if (days === 1) return 'вчера';
  if (days < 7) return `${days} ${plural(days, 'день', 'дня', 'дней')} назад`;
  if (days < 30) {
    const w = Math.round(days / 7);
    return `${w} ${plural(w, 'неделю', 'недели', 'недель')} назад`;
  }
  if (days < 365) {
    const m = Math.round(days / 30);
    return `${m} ${plural(m, 'месяц', 'месяца', 'месяцев')} назад`;
  }
  const y = Math.round(days / 365);
  return `${y} ${plural(y, 'год', 'года', 'лет')} назад`;
}

/** «Бесплатно», «500 ₽», «1 000 ₽»; цена не задана — пусто. */
export function priceLabel(price: number | null): string {
  if (price == null) return '';
  return price === 0 ? 'Бесплатно' : `${formatNumber(price)} ₽`;
}

/** «4,97» — оценка с двумя знаками и запятой. */
export function ratingLabel(avg: number): string {
  return avg.toFixed(2).replace('.', ',');
}

/** «60 мин · 5 км · 31 стр. · 11 заданий» — длительность, маршрут, состав. */
export function factsLine(q: ConstructorQuestWire): string {
  const km = String(Math.round(q.distance_km * 10) / 10).replace('.', ',');
  const parts = [`${q.duration_min} мин`, `${km} км`, `${q.steps} стр.`];
  if (q.tasks != null) parts.push(`${q.tasks} ${plural(q.tasks, 'задание', 'задания', 'заданий')}`);
  return parts.join(' · ');
}

const VIEW_KEY = 'geohod.ctor.tilesView.v1';

/** Вид списка, запомненный в этом браузере; без хранилища — плитки. */
export function readTileView(): TileView {
  try {
    return localStorage.getItem(VIEW_KEY) === 'rows' ? 'rows' : 'tiles';
  } catch {
    return 'tiles';
  }
}

export function writeTileView(view: TileView): void {
  try {
    localStorage.setItem(VIEW_KEY, view);
  } catch {
    /* приватный режим / запрет хранилища — вид просто не запомнится */
  }
}
