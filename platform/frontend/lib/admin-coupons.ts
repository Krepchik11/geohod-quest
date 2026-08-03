/**
 * Pure core of the admin Coupons screens (Admin Coupons.dc.html): wire mapping,
 * derived labels (discount, validity, scope, usage), status filtering with the
 * automatic archive, RU plural agreement and date formatting, and the code
 * generator behind «Сгенерировать». Kept out of the components so every rule is
 * unit-testable and has a single responsibility (mirrors lib/admin-users.ts).
 */
import type { AdminCouponWire } from './api';
import { dottedDay, formatNumber, pluralCount } from './ru';
import { questPlural } from './storefront';
import { addDays, dayFromUnix } from './utc-day';

/** Derived lifecycle status, exactly as the backend serves it. */
export type CouponStatus = 'active' | 'paused' | 'expired' | 'exhausted';

/** Status chip labels (list badges + editor header). */
export const STATUS_LABELS: Record<CouponStatus, string> = {
  active: 'Активен',
  paused: 'На паузе',
  expired: 'Истёк',
  exhausted: 'Исчерпан',
};

/** List filter chips: everything, live subsets, and the automatic archive. */
export type CouponFilter = 'all' | 'active' | 'paused' | 'archive';

export const FILTER_LABELS: Record<CouponFilter, string> = {
  all: 'Все',
  active: 'Активные',
  paused: 'На паузе',
  archive: 'Архив',
};

export const FILTER_ORDER: CouponFilter[] = ['all', 'active', 'paused', 'archive'];

/** View-model for one coupon (list row + editor). */
export interface AdminCoupon {
  id: string;
  code: string;
  discountType: 'percent' | 'fixed';
  discountValue: number;
  /** "YYYY-MM-DD" or null (бессрочный). */
  validUntil: string | null;
  maxRedemptions: number | null;
  perUserLimit: number | null;
  /** null = все квесты. */
  questIds: string[] | null;
  paused: boolean;
  status: CouponStatus;
  used: number;
  lastRedeemedAt: string | null;
  totalDiscounted: number;
  createdAt: string;
}

/** Map a wire coupon to the view-model (unknown status degrades to active). */
export function toAdminCoupon(w: AdminCouponWire): AdminCoupon {
  const known: CouponStatus[] = ['active', 'paused', 'expired', 'exhausted'];
  return {
    id: w.coupon_id,
    code: w.code,
    discountType: w.discount_type,
    discountValue: w.discount_value,
    validUntil: w.valid_until,
    maxRedemptions: w.max_redemptions,
    perUserLimit: w.per_user_limit,
    questIds: w.quest_ids,
    paused: w.paused,
    status: known.includes(w.status as CouponStatus) ? (w.status as CouponStatus) : 'active',
    used: w.used,
    lastRedeemedAt: w.last_redeemed_at,
    totalDiscounted: w.total_discounted,
    createdAt: w.created_at,
  };
}

/** Expired and exhausted coupons archive automatically («Архив»). */
export function isArchived(c: Pick<AdminCoupon, 'status'>): boolean {
  return c.status === 'expired' || c.status === 'exhausted';
}

/**
 * Status filter AND case-insensitive code substring search. Order-preserving —
 * the server already sorts newest-first.
 */
export function filterCoupons(
  coupons: AdminCoupon[],
  filter: CouponFilter,
  query: string,
): AdminCoupon[] {
  const q = query.trim().toLowerCase();
  return coupons
    .filter((c) => {
      if (filter === 'all') return true;
      if (filter === 'archive') return isArchived(c);
      return c.status === filter;
    })
    .filter((c) => !q || c.code.toLowerCase().includes(q));
}

/** «−20%» / «−300 ₽» — the list's discount column. */
export function discountLabel(c: Pick<AdminCoupon, 'discountType' | 'discountValue'>): string {
  return c.discountType === 'percent'
    ? `−${c.discountValue}%`
    : `−${formatNumber(c.discountValue)} ₽`;
}

/** "YYYY-MM-DD" → "DD.MM.YYYY"; passthrough on junk. */
export function formatDate(iso: string): string {
  return /^\d{4}-\d{2}-\d{2}$/.test(iso) ? dottedDay(iso) : iso;
}

/** Validity column: «до 15.09.2026» / «бессрочный» / «истёк 01.07.2026». */
export function validityLabel(c: Pick<AdminCoupon, 'validUntil' | 'status'>): string {
  if (!c.validUntil) return 'бессрочный';
  const date = formatDate(c.validUntil);
  return c.status === 'expired' ? `истёк ${date}` : `до ${date}`;
}

/** «1 квест / 2 квеста / 5 квестов». */
export const pluralizeQuests = (n: number) => `${n} ${questPlural(n)}`;

/** «N купон / купона / купонов». */
export const pluralizeCoupons = (n: number) => pluralCount(n, 'купон', 'купона', 'купонов');

/** Scope line under the code: «Все квесты · 1 на пользователя». */
export function scopeLabel(
  c: Pick<AdminCoupon, 'questIds' | 'perUserLimit'>,
): string {
  const quests = c.questIds === null ? 'Все квесты' : pluralizeQuests(c.questIds.length);
  const perUser =
    c.perUserLimit === null
      ? 'без лимита на пользователя'
      : c.perUserLimit === 1
        ? '1 на пользователя'
        : `${c.perUserLimit} на пользователя`;
  return `${quests} · ${perUser}`;
}

/** Usage column copy: «34 из 100» or «128 · без лимита». */
export function usageLabel(c: Pick<AdminCoupon, 'used' | 'maxRedemptions'>): string {
  return c.maxRedemptions === null
    ? `${c.used} · без лимита`
    : `${c.used} из ${c.maxRedemptions}`;
}

/** Fill percent for the usage bar; null = unlimited (striped bar, no honest %). */
export function usagePercent(c: Pick<AdminCoupon, 'used' | 'maxRedemptions'>): number | null {
  if (c.maxRedemptions === null) return null;
  if (c.maxRedemptions <= 0) return 100;
  return Math.min(100, Math.round((c.used / c.maxRedemptions) * 100));
}

/**
 * Humanized last-redemption instant for the editor's usage card: «сегодня» /
 * «вчера» / DD.MM.YYYY. `now` is injected for determinism (tests, SSR safety);
 * both instants are compared by their UTC calendar date.
 */
export function lastUsedLabel(iso: string | null, now: Date): string {
  if (!iso) return '—';
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '—';
  const day = dayFromUnix(Math.floor(t / 1000));
  const today = dayFromUnix(Math.floor(now.getTime() / 1000));
  if (day >= today) return 'сегодня';
  if (day === addDays(today, -1)) return 'вчера';
  return formatDate(day);
}

/** Brand tile palette for quest rows without a cover (design's letter tiles). */
const TILE_COLORS = ['#122947', '#1F8A5B', '#B45309', '#5B6373', '#C0395C'];

/** Deterministic tile color for a quest id (stable across renders/sessions). */
export function tileColor(questId: string): string {
  let hash = 0;
  for (let i = 0; i < questId.length; i += 1) {
    hash = (hash * 31 + questId.charCodeAt(i)) | 0;
  }
  return TILE_COLORS[Math.abs(hash) % TILE_COLORS.length];
}

/** Code charset for «Сгенерировать» (unambiguous: no O/0/I/1 lookalikes). */
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

/**
 * Generate a fresh coupon code («GEO-X7K2Q9» style) from a caller-supplied
 * random byte source (`crypto.getRandomValues` in the browser; injected so the
 * generator stays pure and testable). Rejection sampling keeps it unbiased.
 */
export function generateCode(randomBytes: (n: number) => Uint8Array): string {
  const out: string[] = [];
  while (out.length < 6) {
    for (const byte of randomBytes(8)) {
      // 31-char alphabet: accept bytes < 248 (8 * 31) to avoid modulo bias.
      if (byte < 248 && out.length < 6) out.push(CODE_ALPHABET[byte % 31]);
    }
  }
  return `GEO-${out.join('')}`;
}
