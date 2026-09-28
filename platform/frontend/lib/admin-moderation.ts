import type { AdminIdentityWire, AdminReviewWire, ModerationMarkWire } from './api';
import { plural } from './ru';
import { fmtRating } from './storefront';

/**
 * View-model helpers for the two moderation tabs (Отзывы + Обратная связь) — pure
 * functions kept out of the page components so they can be unit-tested and shared:
 * Russian relative time, identity badge/contact resolution (matching the backend
 * `kind`), the step-template label map, quest-filter options, the hide-aware
 * quest average that powers the confirm-dialog before→after preview (a same-grain TS
 * mirror of the server fold, kept in step by tests), and the Отзывы filter/sort
 * model with its URL codec.
 */

export { fmtRating as formatAverage };

/** Relative Russian time from a unix-seconds instant, e.g. «2 дня назад». */
export function relativeTime(unixSeconds: number, nowMs: number = Date.now()): string {
  const diff = Math.max(0, Math.floor(nowMs / 1000) - Math.floor(unixSeconds));
  const DAY = 86_400;
  if (diff < 60) return 'только что';
  if (diff < 3_600) {
    const m = Math.floor(diff / 60);
    return `${m} ${plural(m, 'минуту', 'минуты', 'минут')} назад`;
  }
  if (diff < DAY) {
    const h = Math.floor(diff / 3_600);
    return `${h} ${plural(h, 'час', 'часа', 'часов')} назад`;
  }
  const d = Math.floor(diff / DAY);
  if (d < 7) return `${d} ${plural(d, 'день', 'дня', 'дней')} назад`;
  if (d < 30) {
    const w = Math.floor(d / 7);
    return `${w} ${plural(w, 'неделю', 'недели', 'недель')} назад`;
  }
  if (d < 365) {
    const mo = Math.floor(d / 30);
    return `${mo} ${plural(mo, 'месяц', 'месяца', 'месяцев')} назад`;
  }
  const y = Math.floor(d / 365);
  return `${y} ${plural(y, 'год', 'года', 'лет')} назад`;
}

/** A display name for an admin surface: the account name, else a kind-appropriate label. */
export function identityName(identity: AdminIdentityWire): string {
  const name = identity.display_name?.trim();
  if (name) return name;
  return identity.kind === 'anon' ? 'Гость' : identity.user_id;
}

export interface Badge {
  label: string;
  kind: AdminIdentityWire['kind'];
}

/** Provider badge label per `kind` (Google / Telegram / Почта / Аноним). */
export function identityBadge(kind: AdminIdentityWire['kind']): Badge {
  const label =
    kind === 'google'
      ? 'Google'
      : kind === 'telegram'
        ? 'Telegram'
        : kind === 'email'
          ? 'Почта'
          : 'Аноним';
  return { label, kind };
}

export interface Contact {
  glyph: string;
  label: string;
  /** `null` when there is no reachable contact (disabled row). */
  href: string | null;
}

/**
 * The single reachable contact for an identity: email → `mailto:`, Telegram with a
 * captured handle → `t.me/…`, otherwise a disabled label (handleless Telegram / anon).
 */
export function identityContact(identity: AdminIdentityWire): Contact {
  // The backend already nulls every contact field that doesn't apply to the account's
  // kind, so surface whichever it provided — no need to re-derive the kind decision.
  if (identity.email) {
    return { glyph: '✉', label: identity.email, href: `mailto:${identity.email}` };
  }
  if (identity.telegram_username) {
    return {
      glyph: '✈',
      label: `@${identity.telegram_username}`,
      href: `https://t.me/${identity.telegram_username}`,
    };
  }
  if (identity.kind === 'telegram') {
    return { glyph: '✈', label: 'Telegram · нет @username', href: null };
  }
  return { glyph: '—', label: 'аноним · контакта нет', href: null };
}

const TEMPLATE_LABELS: Record<string, string> = {
  start: 'старт',
  video: 'видео',
  task_answer: 'вопрос',
  task_no: 'задание',
  continue: 'переход',
  route_video: 'маршрут',
  congrats: 'финал',
};

/** Human step-template label (matches the design), falling back to the raw value. */
export function templateLabel(template: string | null): string {
  if (!template) return '';
  return TEMPLATE_LABELS[template] ?? template;
}

export interface QuestAverage {
  avg: number | null;
  count: number;
}

/**
 * The quest's average over its NON-hidden ratings — the same per-player, hide-aware
 * grain the server folds, so the confirm-dialog preview matches what ships. Pass
 * `excludeUserId` to compute the «after» value when hiding that player's rating.
 */
export function questAverage(
  reviews: readonly AdminReviewWire[],
  questId: string,
  excludeUserId?: string,
): QuestAverage {
  const kept = reviews.filter(
    (r) =>
      r.quest_id === questId &&
      !r.hidden &&
      r.identity.user_id !== excludeUserId,
  );
  if (kept.length === 0) return { avg: null, count: 0 };
  const sum = kept.reduce((acc, r) => acc + r.rating, 0);
  return { avg: sum / kept.length, count: kept.length };
}

/** «Все квесты» + one `<select>` option per distinct quest present, in first-seen order. */
export function questFilterOptions(
  items: ReadonlyArray<{ quest_id: string; quest_name: string }>,
): Array<{ value: string; label: string }> {
  const seen = new Map<string, string>();
  for (const it of items) if (!seen.has(it.quest_id)) seen.set(it.quest_id, it.quest_name);
  return [
    { value: 'all', label: 'Все квесты' },
    ...[...seen].map(([value, label]) => ({ value, label })),
  ];
}

/**
 * A moderation timestamp: relative inside the last week («2 дня назад»), the
 * calendar date beyond it («12.05.2024») — «2 года назад» is too coarse to tell
 * two old reviews apart.
 */
export function moderationDate(unixSeconds: number, nowMs: number = Date.now()): string {
  if (nowMs / 1000 - unixSeconds < 7 * 86_400) return relativeTime(unixSeconds, nowMs);
  return new Date(unixSeconds * 1000).toLocaleDateString('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  });
}

/* ── Отзывы: «Проверено» ─────────────────────────────────────────────────────── */

/**
 * Where a review stands with the moderators: `new` — no admin has checked it;
 * `changed` — checked once, then the player changed the stars or the text;
 * `checked` — a «Проверено» covers its current version.
 */
export type ReviewStatus = 'new' | 'changed' | 'checked';

export function reviewStatus(r: Pick<AdminReviewWire, 'check' | 'changed_at'>): ReviewStatus {
  if (!r.check) return 'new';
  return r.check.through < r.changed_at ? 'changed' : 'checked';
}

/**
 * Who made a moderation mark, as a card names them: the admin's name or email,
 * the operator token by its role, the raw id otherwise; `null` for the history
 * that went live already checked (`baseline`) — nobody to name there.
 */
export function markWho(mark: Pick<ModerationMarkWire, 'by_id' | 'by_name'>): string | null {
  if (mark.by_name) return mark.by_name;
  if (mark.by_id === 'baseline') return null;
  if (mark.by_id === 'ops-token') return 'служебный токен';
  return mark.by_id;
}

/* ── Отзывы: filters, sort and their URL ──────────────────────────────────────
   `?view=hidden&quest=q-1&rating=4&text=with&q=спасибо&sort=worst` — defaults
   are left out, so the plain page is the plain URL. */

export type ReviewSort = 'new' | 'worst' | 'best';
/** `new` — not checked at the current version, hidden or not. */
export type ReviewView = 'new' | 'visible' | 'hidden' | 'all';
export type ReviewText = 'all' | 'with' | 'without';

export interface ReviewsQuery {
  /** A quest id, or `'all'`. */
  quest: string;
  /** 1–5, or 0 for every rating. */
  rating: number;
  view: ReviewView;
  /** A written review, a star-only rating, or either. */
  text: ReviewText;
  /** The search box, as typed; `''` for none. */
  q: string;
  sort: ReviewSort;
}

export const DEFAULT_REVIEWS_QUERY: ReviewsQuery = {
  quest: 'all',
  rating: 0,
  view: 'visible',
  text: 'all',
  q: '',
  sort: 'new',
};

export const REVIEW_SORTS: ReadonlyArray<{ key: ReviewSort; label: string }> = [
  { key: 'new', label: 'Сначала новые' },
  { key: 'worst', label: 'Сначала худшие' },
  { key: 'best', label: 'Сначала лучшие' },
];

export const REVIEW_VIEWS: ReadonlyArray<{ key: ReviewView; label: string }> = [
  { key: 'new', label: 'Новые' },
  { key: 'visible', label: 'Видимые' },
  { key: 'hidden', label: 'Скрытые' },
  { key: 'all', label: 'Все' },
];

export const REVIEW_TEXTS: ReadonlyArray<{ key: ReviewText; label: string }> = [
  { key: 'all', label: 'Все' },
  { key: 'with', label: 'С текстом' },
  { key: 'without', label: 'Только звёзды' },
];

/** Unknown or malformed values fall back to the default, one key at a time. */
export function parseReviewsQuery(search: string): ReviewsQuery {
  const p = new URLSearchParams(search);
  const sort = REVIEW_SORTS.find((s) => s.key === p.get('sort'))?.key;
  const view = REVIEW_VIEWS.find((v) => v.key === p.get('view'))?.key;
  const text = REVIEW_TEXTS.find((t) => t.key === p.get('text'))?.key;
  const rating = Number(p.get('rating'));
  return {
    quest: p.get('quest') || DEFAULT_REVIEWS_QUERY.quest,
    rating: Number.isInteger(rating) && rating >= 1 && rating <= 5 ? rating : 0,
    view: view ?? DEFAULT_REVIEWS_QUERY.view,
    text: text ?? DEFAULT_REVIEWS_QUERY.text,
    q: p.get('q') ?? DEFAULT_REVIEWS_QUERY.q,
    sort: sort ?? DEFAULT_REVIEWS_QUERY.sort,
  };
}

/** `''` for the defaults, else `?…` with only the non-default keys. */
export function serializeReviewsQuery(q: ReviewsQuery): string {
  const p = new URLSearchParams();
  if (q.view !== DEFAULT_REVIEWS_QUERY.view) p.set('view', q.view);
  if (q.quest !== DEFAULT_REVIEWS_QUERY.quest) p.set('quest', q.quest);
  if (q.rating !== DEFAULT_REVIEWS_QUERY.rating) p.set('rating', String(q.rating));
  if (q.text !== DEFAULT_REVIEWS_QUERY.text) p.set('text', q.text);
  if (q.q.trim()) p.set('q', q.q);
  if (q.sort !== DEFAULT_REVIEWS_QUERY.sort) p.set('sort', q.sort);
  const s = p.toString();
  return s ? `?${s}` : '';
}

/** Case- and ё-insensitive: «Ёлка» finds «елка» and back. */
const fold = (s: string) => s.toLowerCase().replace(/ё/g, 'е');

/**
 * The search box as a predicate: a substring of the review text or of any way to
 * name the author — name, email, Telegram handle (a leading @ is optional), id.
 */
export function reviewSearch(q: string): (r: AdminReviewWire) => boolean {
  const needle = fold(q.trim()).replace(/^@/, '');
  if (!needle) return () => true;
  return (r) =>
    [r.text, r.identity.display_name, r.identity.email, r.identity.telegram_username, r.identity.user_id]
      .some((v) => !!v && fold(v).includes(needle));
}

/** A new array; ties inside one rating (or one instant) fall back to newest-first. */
export function sortReviews(
  reviews: readonly AdminReviewWire[],
  sort: ReviewSort,
): AdminReviewWire[] {
  return reviews.toSorted((a, b) => {
    const newest = b.created_at - a.created_at;
    if (sort === 'worst') return a.rating - b.rating || newest;
    if (sort === 'best') return b.rating - a.rating || newest;
    return newest || a.rating - b.rating;
  });
}

export interface ReviewFacets {
  /** The shown list: every filter and the search applied, sorted. */
  list: AdminReviewWire[];
  /** Per view — counted under every other filter. */
  views: Record<ReviewView, number>;
  /** Per star 1–5 — counted under every other filter. */
  ratings: Record<number, number>;
  /** Per quest id — counted under every other filter. */
  quests: Map<string, number>;
  /** Written vs star-only — counted under every other filter. */
  texts: Record<Exclude<ReviewText, 'all'>, number>;
}

type Filter = 'quest' | 'rating' | 'view' | 'text';

/**
 * The list plus every filter's counts in one pass. Each count applies all the
 * OTHER filters, so it answers «how many would I see if I clicked this». The
 * search narrows everything and has no count of its own.
 */
export function reviewFacets(reviews: readonly AdminReviewWire[], q: ReviewsQuery): ReviewFacets {
  const views: Record<ReviewView, number> = { new: 0, visible: 0, hidden: 0, all: 0 };
  const ratings: Record<number, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  const quests = new Map<string, number>();
  const texts = { with: 0, without: 0 };
  const list: AdminReviewWire[] = [];
  const found = reviewSearch(q.q);
  for (const r of reviews) {
    if (!found(r)) continue;
    const unchecked = reviewStatus(r) !== 'checked';
    const ok: Record<Filter, boolean> = {
      quest: q.quest === 'all' || r.quest_id === q.quest,
      rating: q.rating === 0 || r.rating === q.rating,
      view:
        q.view === 'all' || (q.view === 'new' ? unchecked : r.hidden === (q.view === 'hidden')),
      text: q.text === 'all' || !!r.text === (q.text === 'with'),
    };
    const missed = (Object.keys(ok) as Filter[]).filter((f) => !ok[f]);
    // A filter's own count takes the rows that pass everything else.
    const countsFor = (f: Filter) => missed.length === 0 || (missed.length === 1 && missed[0] === f);
    if (countsFor('view')) {
      views.all += 1;
      views[r.hidden ? 'hidden' : 'visible'] += 1;
      if (unchecked) views.new += 1;
    }
    if (countsFor('rating')) ratings[r.rating] = (ratings[r.rating] ?? 0) + 1;
    if (countsFor('quest')) quests.set(r.quest_id, (quests.get(r.quest_id) ?? 0) + 1);
    if (countsFor('text')) texts[r.text ? 'with' : 'without'] += 1;
    if (missed.length === 0) list.push(r);
  }
  return { list: sortReviews(list, q.sort), views, ratings, quests, texts };
}

export interface QuestSummary extends QuestAverage {
  /** Hidden ratings — out of the average. */
  hidden: number;
  /** Visible ratings per star 1–5. */
  stars: Record<number, number>;
}

/** The quest as the site shows it: the average and star spread of its visible ratings. */
export function questSummary(reviews: readonly AdminReviewWire[], questId: string): QuestSummary {
  const stars: Record<number, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  let hidden = 0;
  for (const r of reviews) {
    if (r.quest_id !== questId) continue;
    if (r.hidden) hidden += 1;
    else stars[r.rating] = (stars[r.rating] ?? 0) + 1;
  }
  return { ...questAverage(reviews, questId), hidden, stars };
}

/** «Все квесты» + every quest present, А–Я, each labelled with its count. */
export function reviewQuestOptions(
  reviews: readonly AdminReviewWire[],
  counts: ReadonlyMap<string, number>,
): Array<{ value: string; label: string }> {
  const names = new Map<string, string>();
  for (const r of reviews) if (!names.has(r.quest_id)) names.set(r.quest_id, r.quest_name);
  return [
    { value: 'all', label: 'Все квесты' },
    ...[...names]
      .toSorted(([, a], [, b]) => a.localeCompare(b, 'ru'))
      .map(([value, name]) => ({ value, label: `${name} · ${counts.get(value) ?? 0}` })),
  ];
}
