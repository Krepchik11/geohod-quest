/**
 * Pure view-model for the admin «Афиша» page (the lib/admin-cities.ts
 * pattern: wire types + display derivations, no React).
 *
 * The backend reads the channel and owns every rule (afisha.rs); the page
 * shows what it read, lets the admin correct a post's fields, hide or show
 * an announcement, take a post by its link and load the archive.
 */

import type {
  AdminAfishaWire,
  AfishaFieldsWire,
  AfishaKind,
  AfishaReportWire,
  AfishaSaveBody,
  AfishaStatus,
} from './generated';
import { KIND_LABEL } from './afisha';
import { dottedDay, pluralCount } from './ru';

export type { AdminAfishaWire, AfishaStatus };

export const STATUS_LABEL: Record<AfishaStatus, string> = {
  published: 'На сайте',
  draft: 'Черновик',
  hidden: 'Скрыт',
  untagged: 'Без хештега',
  removed: 'Удалён из канала',
};

/** The list's filters, in the order the admin works through them. */
export const STATUS_FILTERS: readonly ('all' | AfishaStatus)[] = [
  'all',
  'draft',
  'untagged',
  'published',
  'hidden',
  'removed',
];

export function filterLabel(filter: 'all' | AfishaStatus): string {
  return filter === 'all' ? 'Все' : STATUS_LABEL[filter];
}

/** How many announcements each filter shows. */
export function countByFilter(events: readonly AdminAfishaWire[]): Record<'all' | AfishaStatus, number> {
  const counts = { all: events.length, published: 0, draft: 0, hidden: 0, untagged: 0, removed: 0 };
  for (const e of events) counts[e.status] += 1;
  return counts;
}

/** The edit form's fields, in the post's order. */
export const FORM_FIELDS: readonly {
  key: keyof AfishaFieldsWire;
  label: string;
  input: 'text' | 'date' | 'time' | 'textarea';
}[] = [
  { key: 'title', label: 'Название', input: 'text' },
  { key: 'date', label: 'Дата', input: 'date' },
  { key: 'time', label: 'Время', input: 'time' },
  { key: 'city', label: 'Город', input: 'text' },
  { key: 'place', label: 'Место встречи', input: 'text' },
  { key: 'distance', label: 'Протяжённость', input: 'text' },
  { key: 'duration', label: 'Длительность', input: 'text' },
  { key: 'route', label: 'Маршрут', input: 'text' },
  { key: 'difficulty', label: 'Сложность', input: 'text' },
  { key: 'guide', label: 'Ведущий', input: 'text' },
  { key: 'price', label: 'Стоимость', input: 'text' },
  { key: 'expenses', label: 'Личные расходы', input: 'text' },
  { key: 'bring', label: 'Что взять', input: 'text' },
  { key: 'description', label: 'Описание', input: 'textarea' },
];

/** The form as typed: every field a string, the kind blank for «не указан». */
export interface AfishaDraft {
  kind: AfishaKind | '';
  fields: Record<keyof AfishaFieldsWire, string>;
}

export function draftOf(event: AdminAfishaWire): AfishaDraft {
  const fields = {} as Record<keyof AfishaFieldsWire, string>;
  for (const { key } of FORM_FIELDS) fields[key] = event.fields[key] ?? '';
  return { kind: event.kind ?? '', fields };
}

/** The save body: blank means none (the server trims and validates again). */
export function saveBodyOf(postId: number, draft: AfishaDraft): AfishaSaveBody {
  const value = (key: keyof AfishaFieldsWire) => draft.fields[key].trim() || null;
  return {
    post_id: postId,
    kind: draft.kind || null,
    fields: {
      title: draft.fields.title.trim(),
      date: value('date'),
      time: value('time'),
      city: value('city'),
      place: value('place'),
      distance: value('distance'),
      duration: value('duration'),
      route: value('route'),
      difficulty: value('difficulty'),
      guide: value('guide'),
      price: value('price'),
      expenses: value('expenses'),
      bring: value('bring'),
      description: value('description'),
    },
  };
}

/** «11.10.2026, 12:45» — or what is missing. */
export function whenLabel(event: AdminAfishaWire): string {
  const { date, time } = event.fields;
  if (!date) return 'без даты';
  return time ? `${dottedDay(date)}, ${time}` : `${dottedDay(date)}, без времени`;
}

export function kindLabel(kind: AfishaKind | null): string {
  return kind ? KIND_LABEL[kind] : 'Тип не указан';
}

/** The fields a re-read post leaves alone — set by the admin, or the kind an
 *  import guessed: «тип, название». */
export function editedLabel(event: AdminAfishaWire): string | null {
  const names = event.edited.map((key) =>
    key === 'kind' ? 'тип' : (FORM_FIELDS.find((f) => f.key === key)?.label.toLowerCase() ?? key),
  );
  return names.length ? names.join(', ') : null;
}

/** What a read of the channel did, for the toast. */
export function reportText(report: AfishaReportWire): string {
  const read = pluralCount(report.read, 'пост', 'поста', 'постов');
  const posts = `Прочитано ${read}: новых ${report.created}, обновлено ${report.updated}, снято ${report.removed}`;
  const pictures = picturesText(report.images_stored, report.images_reused);
  return pictures ? `${posts}; ${pictures}` : posts;
}

/** «картинок сохранено 44, повторов не сохранено 59» — empty when no picture moved. */
export function picturesText(stored: number, reused: number): string {
  if (stored === 0 && reused === 0) return '';
  return `картинок сохранено ${stored}, повторов не сохранено ${reused}`;
}

/** The years the archive import offers, newest first; `null` is the whole channel. */
export function archiveYears(now: Date = new Date()): (number | null)[] {
  const year = now.getFullYear();
  return [year, year - 1, year - 2, year - 3, null];
}
