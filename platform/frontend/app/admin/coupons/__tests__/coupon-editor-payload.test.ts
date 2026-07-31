import { describe, expect, it } from 'vitest';
import { buildPayload, questPickerRows } from '../CouponEditor';

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

describe('questPickerRows', () => {
  const catalog = [
    { quest_id: 'q1', name: 'Тайны', price: 500 },
    { quest_id: 'q2', name: 'Дозор', price: null },
  ];

  it('offers every catalog quest when nothing is selected', () => {
    expect(questPickerRows(catalog, [], '')).toEqual([
      { questId: 'q1', name: 'Тайны', price: 500, offCatalog: false },
      { questId: 'q2', name: 'Дозор', price: 0, offCatalog: false },
    ]);
  });

  // A coupon scoped to a quest that has since left the catalog kept that id in
  // the payload and in «Выбрано: N», but the picker rendered no row for it — a
  // selection the admin could neither see nor remove.
  it('keeps a selected quest the catalog no longer offers, flagged and removable', () => {
    const rows = questPickerRows(catalog, ['q1', 'gone-7'], '');
    expect(rows.map((r) => r.questId)).toEqual(['q1', 'q2', 'gone-7']);
    // price stays null rather than rendering a fabricated «0 ₽».
    expect(rows[2]).toEqual({ questId: 'gone-7', name: 'gone-7', price: null, offCatalog: true });
  });

  it('never duplicates a selected quest that is still in the catalog', () => {
    expect(questPickerRows(catalog, ['q1', 'q2'], '').map((r) => r.questId)).toEqual(['q1', 'q2']);
  });

  it('searches names, and the id for an off-catalog quest (its only visible text)', () => {
    expect(questPickerRows(catalog, ['gone-7'], 'дозор').map((r) => r.questId)).toEqual(['q2']);
    expect(questPickerRows(catalog, ['gone-7'], 'GONE').map((r) => r.questId)).toEqual(['gone-7']);
    expect(questPickerRows(catalog, ['gone-7'], 'нет такого')).toEqual([]);
  });
});
