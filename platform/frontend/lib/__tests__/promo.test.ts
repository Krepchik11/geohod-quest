// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import type { PublishedQuestWire, RedeemReject } from '../api';
import {
  forgetPromo,
  freeAlternative,
  giftUntilLabel,
  pendingPromo,
  promoNotice,
  rememberPromo,
} from '../promo';

/** QR invitations, the guest's side (flag promo_qr): the pure rules + the tab memory. */

function quest(over: Partial<PublishedQuestWire>): PublishedQuestWire {
  return {
    quest_id: 'q',
    name: 'Квест',
    city: 'Нови Сад',
    price: 0,
    players: 0,
    rating_avg: 0,
    rating_count: 0,
    ...over,
  } as PublishedQuestWire;
}

describe('promoNotice', () => {
  it('says an invitation is over for good when it ran out, expired or is gone', () => {
    for (const reason of ['exhausted', 'expired', 'not_found'] as RedeemReject[]) {
      expect(promoNotice(reason)).toEqual({ text: 'Приглашение закончилось', ended: true });
    }
  });

  it('has its own line for a pause, a second use and another quest', () => {
    expect(promoNotice('paused')).toEqual({ text: 'Приглашение временно не действует', ended: false });
    expect(promoNotice('per_user_limit')).toEqual({
      text: 'Вы уже использовали это приглашение',
      ended: false,
    });
    expect(promoNotice('not_applicable').ended).toBe(false);
  });
});

describe('freeAlternative', () => {
  const catalog = [
    quest({ quest_id: 'paid', name: 'Платный', price: 500, players: 900 }),
    quest({ quest_id: 'irony', name: 'Ирония Судьбы', players: 330 }),
    quest({ quest_id: 'fortress', name: 'Тайна крепости', players: 477 }),
    quest({ quest_id: 'petrovich', name: 'Петрович', city: 'Белград', players: 117 }),
    quest({ quest_id: 'unpriced', name: 'Без цены', price: null, players: 999 }),
  ];

  it('picks the most played free quest of the same city', () => {
    expect(freeAlternative(catalog, 'Нови Сад', 'gift')?.name).toBe('Тайна крепости');
    expect(freeAlternative(catalog, 'Белград', 'gift')?.name).toBe('Петрович');
  });

  it('never suggests the quest itself, and nothing for a city without a free quest', () => {
    expect(freeAlternative(catalog, 'Нови Сад', 'fortress')?.name).toBe('Ирония Судьбы');
    expect(freeAlternative(catalog, 'Сремски Карловци', 'gift')).toBeNull();
    expect(freeAlternative(catalog, null, 'gift')).toBeNull();
  });
});

describe('giftUntilLabel', () => {
  it('names the last valid day, or nothing for an open-ended invitation', () => {
    expect(giftUntilLabel('2026-11-30')).toBe('Приглашение действует до 30.11.2026');
    expect(giftUntilLabel(null)).toBeNull();
  });
});

describe('the tab memory of an unused code', () => {
  beforeEach(() => window.sessionStorage.clear());

  it('keeps a code per quest until it is forgotten', () => {
    expect(pendingPromo('q1')).toBeNull();
    rememberPromo('q1', 'GEO-7KX2M9');
    expect(pendingPromo('q1')).toBe('GEO-7KX2M9');
    expect(pendingPromo('q2')).toBeNull();
    forgetPromo('q1');
    expect(pendingPromo('q1')).toBeNull();
  });
});
