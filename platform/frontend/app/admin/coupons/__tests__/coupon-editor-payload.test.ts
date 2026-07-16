import { describe, expect, it } from 'vitest';
import { buildPayload } from '../CouponEditor';

const base = {
  code: 'LETO-20',
  discountType: 'percent' as const,
  discountValue: '20',
  noExpiry: true,
  validUntil: '',
  noLimit: true,
  maxRedemptions: '',
  noPerUserLimit: true,
  perUserLimit: '',
  allQuests: true,
  questIds: [],
  paused: false,
};

describe('buildPayload', () => {
  it('accepts any non-empty code (no format restrictions)', () => {
    for (const code of ['ab', 'ЛЕТО 2026', '---', 'x'.repeat(64)]) {
      const built = buildPayload({ ...base, code });
      expect('payload' in built && built.payload.code).toBe(code);
    }
  });

  it('rejects only an empty code', () => {
    const built = buildPayload({ ...base, code: '   ' });
    expect('error' in built).toBe(true);
  });

  it('defaults per-user limit to unlimited via the checkbox', () => {
    const built = buildPayload(base);
    if ('error' in built) throw new Error(built.error);
    expect(built.payload.per_user_limit).toBeNull();
  });

  it('sends the per-user limit when the checkbox is off', () => {
    const built = buildPayload({ ...base, noPerUserLimit: false, perUserLimit: '3' });
    if ('error' in built) throw new Error(built.error);
    expect(built.payload.per_user_limit).toBe(3);
  });

  it('rejects a non-positive per-user limit when the checkbox is off', () => {
    for (const perUserLimit of ['', '0']) {
      const built = buildPayload({ ...base, noPerUserLimit: false, perUserLimit });
      expect('error' in built).toBe(true);
    }
  });
});
