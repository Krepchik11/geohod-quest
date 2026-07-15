/**
 * Pure core of the admin Coupons screens (Admin Coupons.dc.html): wire mapping,
 * derived labels (discount, validity, scope, usage), status filtering with the
 * automatic archive, RU plural agreement and date formatting, and the code
 * generator behind «Сгенерировать». Kept out of the components so every rule is
 * unit-testable and has a single responsibility (mirrors lib/admin-users.ts).
 */
import type { AdminCouponWire } from './api';

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

/** Group digits with a narrow gap the way the design writes rubles: 1 200. */
export function formatRubles(n: number): string {
  return new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 }).format(n).replace(/ /g, ' ');
}

/** «−20%» / «−300 ₽» — the list's discount column. */
export function discountLabel(c: Pick<AdminCoupon, 'discountType' | 'discountValue'>): string {
  return c.discountType === 'percent'
    ? `−${c.discountValue}%`
    : `−${formatRubles(c.discountValue)} ₽`;
}

/** "YYYY-MM-DD" → "DD.MM.YYYY" (the design's date format); passthrough on junk. */
export function formatDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  return m ? `${m[3]}.${m[2]}.${m[1]}` : iso;
}

/** Validity column: «до 15.09.2026» / «бессрочный» / «истёк 01.07.2026». */
export function validityLabel(c: Pick<AdminCoupon, 'validUntil' | 'status'>): string {
  if (!c.validUntil) return 'бессрочный';
  const date = formatDate(c.validUntil);
  return c.status === 'expired' ? `истёк ${date}` : `до ${date}`;
}

/** «1 квест / 2 квеста / 5 квестов» with correct Russian plural agreement. */
export function pluralizeQuests(n: number): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  const word =
    mod10 === 1 && mod100 !== 11
      ? 'квест'
      : mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)
        ? 'квеста'
        : 'квестов';
  return `${n} ${word}`;
}

/** «N купон / купона / купонов». */
export function pluralizeCoupons(n: number): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  const word =
    mod10 === 1 && mod100 !== 11
      ? 'купон'
      : mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)
        ? 'купона'
        : 'купонов';
  return `${n} ${word}`;
}

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
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const day = (x: Date) => Math.floor(x.getTime() / 86_400_000);
  const diff = day(now) - day(d);
  if (diff <= 0) return 'сегодня';
  if (diff === 1) return 'вчера';
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  return `${dd}.${mm}.${d.getUTCFullYear()}`;
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
