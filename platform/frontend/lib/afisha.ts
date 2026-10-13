/**
 * «Афиша» — the public pages of the group walks and group quests announced in
 * the Telegram channel (backend afisha.rs reads the channel; the pages render
 * on the server, so search engines and AI crawlers read them without
 * JavaScript). Pure helpers plus the server-side reads; no React.
 */

import type { AfishaEventWire, AfishaKind } from './generated';
import { API_BASE } from './api';
import { CLUB_CHANNEL_URL } from './contacts';
import { siteUrl } from './share';

export type { AfishaEventWire, AfishaKind };

/** How long a rendered page is served before it reads the API again. */
export const REVALIDATE_SECONDS = 300;

/** How many past announcements the archive lists. */
export const ARCHIVE_LIMIT = 300;

export const KIND_LABEL: Record<AfishaKind, string> = {
  hiking: 'Прогулка',
  quest: 'Групповой квест',
};

/** The labelled facts of an announcement, in the order the post gives them. */
export const FACT_LABELS = [
  ['place', 'Место встречи'],
  ['distance', 'Протяжённость'],
  ['duration', 'Длительность'],
  ['route', 'Маршрут'],
  ['difficulty', 'Сложность'],
  ['guide', 'Ведущий'],
  ['price', 'Стоимость'],
  ['expenses', 'Личные расходы'],
  ['bring', 'Что взять'],
] as const satisfies readonly (readonly [keyof AfishaEventWire, string])[];

/** The facts an announcement has, as label/value pairs. */
export function eventFacts(event: AfishaEventWire): { label: string; value: string }[] {
  return FACT_LABELS.flatMap(([key, label]) => {
    const value = event[key];
    return typeof value === 'string' && value ? [{ label, value }] : [];
  });
}

/**
 * Read the API on the server; `null` while the «Афиша» is off (404). An
 * unreachable API fails the render — the cached page keeps being served —
 * except during `next build`, where the page is built as «off» and
 * regenerates at runtime, so a build never depends on the API being up.
 */
async function readAfisha<T>(path: string): Promise<T | null> {
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, { next: { revalidate: REVALIDATE_SECONDS } });
  } catch (err) {
    if (process.env.NEXT_PHASE === 'phase-production-build') return null;
    throw err;
  }
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`afisha ${path}: HTTP ${res.status}`);
  return (await res.json()) as T;
}

/** Upcoming announcements (soonest first) or past ones (newest first). */
export function fetchAfisha(when: 'upcoming' | 'past', limit?: number): Promise<AfishaEventWire[] | null> {
  const query = limit ? `when=${when}&limit=${limit}` : `when=${when}`;
  return readAfisha<AfishaEventWire[]>(`/api/afisha?${query}`);
}

/** One published announcement; `null` when there is none. */
export function fetchAfishaEvent(postId: number): Promise<AfishaEventWire | null> {
  return readAfisha<AfishaEventWire>(`/api/afisha/${postId}`);
}

/** The post number that ends an announcement's slug (`…-1110`); `null` for a city slug. */
export function postIdOfSlug(slug: string): number | null {
  const match = /-(\d+)$/.exec(slug) ?? /^(\d+)$/.exec(slug);
  return match ? Number(match[1]) : null;
}

export function eventPath(event: Pick<AfishaEventWire, 'slug'>): string {
  return `/afisha/${event.slug}`;
}

export function cityPath(citySlug: string): string {
  return `/afisha/${citySlug}`;
}

/** «Записаться» goes through the API, which counts the click and redirects to the bot. */
export function registerHref(event: Pick<AfishaEventWire, 'post_id'>): string {
  return `${API_BASE}/api/afisha/${event.post_id}/go`;
}

const MONTHS = [
  'января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
  'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря',
];
const WEEKDAYS = ['воскресенье', 'понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота'];
const WEEKDAYS_SHORT = ['Вс', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'];

/** The calendar parts of a local `YYYY-MM-DD` — no time zone involved. */
function dayParts(date: string): { year: number; month: number; day: number; weekday: number } {
  const [year, month, day] = date.split('-').map(Number);
  return { year, month, day, weekday: new Date(Date.UTC(year, month - 1, day)).getUTCDay() };
}

/** «Сб, 10 октября · 16:30» — a card's line. */
export function shortWhen(event: Pick<AfishaEventWire, 'date' | 'time'>): string {
  const { month, day, weekday } = dayParts(event.date);
  return `${WEEKDAYS_SHORT[weekday]}, ${day} ${MONTHS[month - 1]} · ${event.time}`;
}

/** «Суббота, 10 октября 2026, 16:30» — the event page's line. */
export function longWhen(event: Pick<AfishaEventWire, 'date' | 'time'>): string {
  const { year, month, day, weekday } = dayParts(event.date);
  const name = WEEKDAYS[weekday];
  return `${name[0].toUpperCase()}${name.slice(1)}, ${day} ${MONTHS[month - 1]} ${year}, ${event.time}`;
}

const MONTHS_NOMINATIVE = [
  'Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь',
  'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь',
];

/** «Октябрь 2026» — an archive's month heading. */
export function monthLabel(date: string): string {
  const { year, month } = dayParts(date);
  return `${MONTHS_NOMINATIVE[month - 1]} ${year}`;
}

/** «10 октября 2026» — for titles and descriptions. */
export function dayLabel(date: string): string {
  const { year, month, day } = dayParts(date);
  return `${day} ${MONTHS[month - 1]} ${year}`;
}

export interface AfishaCity {
  name: string;
  slug: string;
  count: number;
}

/** The cities of a list, the busiest first, then by name. */
export function citiesOf(events: readonly AfishaEventWire[]): AfishaCity[] {
  const byCity = new Map<string, AfishaCity>();
  for (const e of events) {
    const city = byCity.get(e.city_slug) ?? { name: e.city, slug: e.city_slug, count: 0 };
    city.count += 1;
    byCity.set(e.city_slug, city);
  }
  return [...byCity.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'ru'));
}

/** Whether the price line says it costs nothing («донат по желанию», «бесплатно»). */
export function isFree(price: string | null): boolean {
  return !!price && /бесплатн|донат|free/i.test(price);
}

/** Whether the price line asks for a donation — the card leaves such a line out. */
export function isDonation(price: string | null): boolean {
  return !!price && /донат/i.test(price);
}

/** ISO country of a city — Serbia unless the channel goes abroad. */
function countryOf(city: string): string {
  const key = city.toLowerCase();
  if (key.includes('стамбул') || key.includes('istanbul')) return 'TR';
  if (key.includes('москв')) return 'RU';
  return 'RS';
}

/** A description for search results: the post's own words, or what it says in one line. */
export function eventSummary(event: AfishaEventWire): string {
  const text = event.description?.replace(/\s+/g, ' ').trim();
  if (text) return text.length > 200 ? `${text.slice(0, 197).trimEnd()}…` : text;
  const where = event.place ? `${event.city}, ${event.place}` : event.city;
  return `${KIND_LABEL[event.kind]} с организатором: ${longWhen(event)}. Место встречи: ${where}.`;
}

/** schema.org Event for an announcement's page — what search engines and AI read. */
export function eventJsonLd(event: AfishaEventWire): Record<string, unknown> {
  const free = isFree(event.price);
  return {
    '@context': 'https://schema.org',
    '@type': 'Event',
    name: event.title,
    description: eventSummary(event),
    startDate: event.starts_at,
    endDate: event.ends_at,
    eventStatus: 'https://schema.org/EventScheduled',
    eventAttendanceMode: 'https://schema.org/OfflineEventAttendanceMode',
    inLanguage: 'ru',
    url: `${siteUrl()}${eventPath(event)}`,
    image: event.image ? [event.image] : undefined,
    isAccessibleForFree: free || undefined,
    location: {
      '@type': 'Place',
      name: event.place ?? event.city,
      address: {
        '@type': 'PostalAddress',
        addressLocality: event.city,
        addressCountry: countryOf(event.city),
        streetAddress: event.place ?? undefined,
      },
    },
    organizer: { '@type': 'Organization', name: 'Прогулки по Сербии', url: CLUB_CHANNEL_URL },
    performer: event.guide ? { '@type': 'Person', name: event.guide } : undefined,
    offers:
      event.register_url && !event.past
        ? {
            '@type': 'Offer',
            url: event.register_url,
            availability: 'https://schema.org/InStock',
            ...(free ? { price: 0, priceCurrency: 'RSD' } : {}),
          }
        : undefined,
  };
}

/** schema.org ItemList of announcement pages — for a hub or a city page. */
export function listJsonLd(name: string, events: readonly AfishaEventWire[]): Record<string, unknown> {
  return {
    '@context': 'https://schema.org',
    '@type': 'ItemList',
    name,
    itemListElement: events.map((e, i) => ({
      '@type': 'ListItem',
      position: i + 1,
      url: `${siteUrl()}${eventPath(e)}`,
      name: e.title,
    })),
  };
}
