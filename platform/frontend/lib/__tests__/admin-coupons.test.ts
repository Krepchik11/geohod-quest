import { describe, expect, it } from 'vitest';
import {
  discountLabel,
  filterCoupons,
  generateCode,
  hasSingleQuest,
  isArchived,
  lastUsedLabel,
  pluralizeCoupons,
  pluralizeQuests,
  qrLink,
  scopeLabel,
  toAdminCoupon,
  usageLabel,
  usagePercent,
  validityLabel,
  type AdminCoupon,
} from '../admin-coupons';

function coupon(over: Partial<AdminCoupon> = {}): AdminCoupon {
  return {
    id: 'cpn-1',
    code: 'LETO-20',
    discountType: 'percent',
    discountValue: 20,
    validUntil: '2026-08-31',
    maxRedemptions: 100,
    perUserLimit: 1,
    questIds: null,
    paused: false,
    status: 'active',
    used: 34,
    lastRedeemedAt: null,
    totalDiscounted: 0,
    createdAt: '2026-06-01T00:00:00Z',
    giftFrom: null,
    qrSlug: null,
    ...over,
  };
}

describe('toAdminCoupon', () => {
  const wire = {
    coupon_id: 'cpn-9',
    code: 'GEOHOD300',
    discount_type: 'fixed' as const,
    discount_value: 300,
    valid_until: null,
    max_redemptions: null,
    per_user_limit: null,
    quest_ids: ['q1'],
    paused: false,
    status: 'weird' as never,
    used: 7,
    last_redeemed_at: '2026-07-14T10:00:00Z',
    total_discounted: 2100,
    created_at: '2026-06-01T00:00:00Z',
    gift_from: 'хостела Fortress',
    qr_slug: '7KX2M9',
  };

  it('maps the wire shape and degrades unknown statuses to active', () => {
    const c = toAdminCoupon(wire);
    expect(c.id).toBe('cpn-9');
    expect(c.discountType).toBe('fixed');
    expect(c.questIds).toEqual(['q1']);
    expect(c.status).toBe('active');
    expect(c.giftFrom).toBe('хостела Fortress');
    expect(c.qrSlug).toBe('7KX2M9');
  });

  it('reads a backend that predates QR invitations as «no QR»', () => {
    const old: Record<string, unknown> = { ...wire };
    delete old.gift_from;
    delete old.qr_slug;
    const c = toAdminCoupon(old as never);
    expect(c.giftFrom).toBeNull();
    expect(c.qrSlug).toBeNull();
  });
});

describe('QR invitation helpers', () => {
  it('allows a QR only for a coupon limited to exactly one quest', () => {
    expect(hasSingleQuest(coupon({ questIds: ['q1'] }))).toBe(true);
    expect(hasSingleQuest(coupon({ questIds: null }))).toBe(false);
    expect(hasSingleQuest(coupon({ questIds: ['q1', 'q2'] }))).toBe(false);
    expect(hasSingleQuest(coupon({ questIds: [] }))).toBe(false);
  });

  it('builds the short link on the given site', () => {
    expect(qrLink('https://quest.geohod.ru', '7KX2M9')).toBe('https://quest.geohod.ru/go/7KX2M9');
  });
});

describe('labels', () => {
  it('formats discounts per the design', () => {
    expect(discountLabel(coupon())).toBe('−20%');
    expect(discountLabel(coupon({ discountType: 'fixed', discountValue: 300 }))).toBe('−300 ₽');
    expect(discountLabel(coupon({ discountType: 'fixed', discountValue: 1200 }))).toBe(
      '−1 200 ₽',
    );
  });

  it('formats validity: до / бессрочный / истёк', () => {
    expect(validityLabel(coupon())).toBe('до 31.08.2026');
    expect(validityLabel(coupon({ validUntil: null }))).toBe('бессрочный');
    expect(validityLabel(coupon({ validUntil: '2026-07-01', status: 'expired' }))).toBe(
      'истёк 01.07.2026',
    );
  });

  it('describes scope with RU plural agreement', () => {
    expect(scopeLabel(coupon())).toBe('Все квесты · 1 на пользователя');
    expect(scopeLabel(coupon({ questIds: ['a', 'b', 'c'] }))).toBe(
      '3 квеста · 1 на пользователя',
    );
    expect(scopeLabel(coupon({ questIds: ['a'], perUserLimit: null }))).toBe(
      '1 квест · без лимита на пользователя',
    );
    expect(scopeLabel(coupon({ questIds: Array.from({ length: 5 }, (_, i) => `${i}`) }))).toBe(
      '5 квестов · 1 на пользователя',
    );
  });

  it('renders usage counts and percent honestly (no fake % when unlimited)', () => {
    expect(usageLabel(coupon())).toBe('34 из 100');
    expect(usagePercent(coupon())).toBe(34);
    expect(usageLabel(coupon({ used: 128, maxRedemptions: null }))).toBe('128 · без лимита');
    expect(usagePercent(coupon({ maxRedemptions: null }))).toBeNull();
    expect(usagePercent(coupon({ used: 25, maxRedemptions: 25 }))).toBe(100);
    expect(usagePercent(coupon({ used: 999, maxRedemptions: 25 }))).toBe(100);
  });

  it('pluralizes купоны and квесты', () => {
    expect(pluralizeCoupons(1)).toBe('1 купон');
    expect(pluralizeCoupons(4)).toBe('4 купона');
    expect(pluralizeCoupons(11)).toBe('11 купонов');
    expect(pluralizeQuests(21)).toBe('21 квест');
    expect(pluralizeQuests(12)).toBe('12 квестов');
  });

  it('humanizes the last redemption instant against an injected now', () => {
    const now = new Date('2026-07-15T12:00:00Z');
    expect(lastUsedLabel(null, now)).toBe('—');
    expect(lastUsedLabel('2026-07-15T01:00:00Z', now)).toBe('сегодня');
    expect(lastUsedLabel('2026-07-14T23:00:00Z', now)).toBe('вчера');
    expect(lastUsedLabel('2026-07-01T10:00:00Z', now)).toBe('01.07.2026');
    expect(lastUsedLabel('garbage', now)).toBe('—');
  });
});

describe('filterCoupons', () => {
  const list = [
    coupon({ id: 'a', code: 'LETO-20', status: 'active' }),
    coupon({ id: 'b', code: 'FRIENDS', status: 'paused' }),
    coupon({ id: 'c', code: 'START10', status: 'exhausted' }),
    coupon({ id: 'd', code: 'OLD-5', status: 'expired' }),
  ];

  it('archive gathers expired + exhausted; live filters match exactly', () => {
    expect(filterCoupons(list, 'all', '').map((c) => c.id)).toEqual(['a', 'b', 'c', 'd']);
    expect(filterCoupons(list, 'active', '').map((c) => c.id)).toEqual(['a']);
    expect(filterCoupons(list, 'paused', '').map((c) => c.id)).toEqual(['b']);
    expect(filterCoupons(list, 'archive', '').map((c) => c.id)).toEqual(['c', 'd']);
    expect(isArchived(list[2])).toBe(true);
    expect(isArchived(list[0])).toBe(false);
  });

  it('searches by code substring, case-insensitive', () => {
    expect(filterCoupons(list, 'all', 'leto').map((c) => c.id)).toEqual(['a']);
    expect(filterCoupons(list, 'archive', 'start').map((c) => c.id)).toEqual(['c']);
    expect(filterCoupons(list, 'all', '  ')).toHaveLength(4);
  });
});

describe('generateCode', () => {
  it('emits GEO-XXXXXX from the unambiguous alphabet, unbiased by rejection', () => {
    // Deterministic "random" source covering the reject branch (byte 250 ≥ 248).
    let calls = 0;
    const bytes = (n: number) => {
      calls += 1;
      const src = calls === 1 ? [250, 0, 1, 2, 3, 4] : [5, 6, 7, 8, 9, 10, 11, 12];
      return Uint8Array.from({ length: n }, (_, i) => src[i % src.length]);
    };
    const code = generateCode(bytes);
    expect(code).toMatch(/^GEO-[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$/);
    const suffix = code.slice(4);
    for (const lookalike of ['O', '0', 'I', '1', 'L']) {
      expect(suffix).not.toContain(lookalike);
    }
  });
});
