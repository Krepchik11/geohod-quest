import type { AdminIdentityWire, AdminReviewWire } from './api';
import { plural } from './ru';
import { fmtRating } from './storefront';

/**
 * View-model helpers for the two moderation tabs (Отзывы + Обратная связь) — pure
 * functions kept out of the page components so they can be unit-tested and shared:
 * Russian relative time, identity badge/contact resolution (matching the backend
 * `kind`), the step-template label map, quest-filter options, and the hide-aware
 * quest average that powers the confirm-dialog before→after preview (a same-grain TS
 * mirror of the server fold, kept in step by tests).
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
