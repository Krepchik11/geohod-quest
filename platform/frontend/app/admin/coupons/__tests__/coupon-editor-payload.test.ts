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
  const authored = [
    { quest_id: 'q1', name: 'Тайны' },
    { quest_id: 'gone-7', name: 'Снятый с продажи' },
  ];

  it('offers every catalog quest when nothing is selected', () => {
    expect(questPickerRows(catalog, authored, [], '')).toEqual([
      { questId: 'q1', name: 'Тайны', price: 500, offCatalog: false },
      { questId: 'q2', name: 'Дозор', price: 0, offCatalog: false },
    ]);
  });

  // A coupon scoped to a quest that has since left the catalog kept that id in
  // the payload and in «Выбрано: N», but the picker rendered no row for it — a
  // selection the admin could neither see nor remove.
  it('keeps a selected quest the catalog no longer offers, named and removable', () => {
    const rows = questPickerRows(catalog, authored, ['q1', 'gone-7'], '');
    expect(rows.map((r) => r.questId)).toEqual(['q1', 'q2', 'gone-7']);
    // Named from the authoring registry, never by raw id; price is a
    // published-version fact and stays absent rather than a fabricated «0 ₽».
    expect(rows[2]).toEqual({
      questId: 'gone-7',
      name: 'Снятый с продажи',
      price: null,
      offCatalog: true,
    });
  });

  it('falls back to the id only when neither source knows the quest', () => {
    const rows = questPickerRows(catalog, authored, ['ghost'], '');
    expect(rows[2]).toEqual({ questId: 'ghost', name: 'ghost', price: null, offCatalog: true });
  });

  it('never duplicates a selected quest that is still in the catalog', () => {
    expect(questPickerRows(catalog, authored, ['q1', 'q2'], '').map((r) => r.questId)).toEqual([
      'q1',
      'q2',
    ]);
  });

  it('searches over the names actually shown', () => {
    expect(questPickerRows(catalog, authored, ['gone-7'], 'дозор').map((r) => r.questId)).toEqual([
      'q2',
    ]);
    expect(questPickerRows(catalog, authored, ['gone-7'], 'снятый').map((r) => r.questId)).toEqual([
      'gone-7',
    ]);
    expect(questPickerRows(catalog, authored, ['gone-7'], 'нет такого')).toEqual([]);
  });
});
