// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import React from 'react';
import { resetCollectionForTests } from '../../../../../lib/collection';

/**
 * QR invitation on the product page (flag promo_qr): `?promo=` turns the
 * order card into «Квест в подарок» with one «Получить бесплатно» — the
 * ordinary checkout with the code, no purchase sheet, no sign-in asked; the
 * account is offered only after. A partial discount opens the sheet with the
 * code applied. A refused invitation says why and the page still sells. An
 * owner sees «Квест ваш» and nothing is priced. With the flag off the code is
 * ignored.
 */
const { getProductMock, listGrantsMock, checkoutMock, validateMock, listQuestsMock, flags } = vi.hoisted(
  () => ({
    getProductMock: vi.fn(),
    listGrantsMock: vi.fn(),
    checkoutMock: vi.fn(),
    validateMock: vi.fn(),
    listQuestsMock: vi.fn(),
    flags: { promo: true },
  }),
);
vi.mock('../../../../../lib/api', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  api: {
    getQuestProduct: getProductMock,
    getQuestReviews: vi.fn(),
    listGrants: listGrantsMock,
    checkout: checkoutMock,
    validateCoupon: validateMock,
    listQuests: listQuestsMock,
    getBundle: vi.fn(),
    paymentProviders: vi.fn().mockResolvedValue({ providers: ['mock'] }),
  },
}));
vi.mock('../../../../../lib/identity', () => ({
  currentUserId: () => 'dev:guest',
  getSession: () => null,
  setSession: vi.fn(),
  subscribeSession: () => () => {},
}));
vi.mock('../../../../../lib/download', () => ({ downloadBundle: vi.fn(async () => ({})) }));
vi.mock('../../../../../lib/payment-return', () => ({ pollPaymentSettlement: vi.fn() }));
vi.mock('../../../../../lib/client-features', () => ({
  useClientFeature: (key: string) => key === 'promo_qr' && flags.promo,
  useUniversalAnswer: () => null,
}));
// The real buttons load provider scripts; the offer around them is what is pinned.
vi.mock('../../../../components/SocialAuthButtons', () => ({ default: () => 'Telegram · Google' }));

import AboutClient from '../AboutClient';
import { ApiError } from '../../../../../lib/api';

const PRODUCT = {
  quest_id: 'q1', name: 'Потерянный друг', primary_comic: null,
  template_summary: '', snapshot_version: 4, snapshot_id: 's4',
  city: 'Нови Сад', duration: '≈ 60 мин', price: 900,
  rating_avg: 4.8, rating_count: 24,
  description: 'Прогулка по кварталам.', author_name: 'Мария К.',
  author_published_count: 3, pages: 12, tasks: 4, paid_hints: true,
  reviews: [], reviews_total: 0,
  start_point: null,
};

const GIFT = {
  valid: true, code: 'GEO-7KX2M9', price: 900, discount_amount: 900, final_price: 0,
  valid_until: '2026-11-30', gift_from: 'хостела Fortress',
};

const ENDED = { valid: false, message: 'Промокод больше не действует — лимит исчерпан', reason: 'exhausted' };

beforeEach(() => {
  flags.promo = true;
  resetCollectionForTests();
  window.sessionStorage.clear();
  getProductMock.mockReset().mockResolvedValue(PRODUCT);
  listGrantsMock.mockReset().mockResolvedValue([]);
  checkoutMock.mockReset();
  validateMock.mockReset().mockResolvedValue(GIFT);
  listQuestsMock.mockReset().mockResolvedValue([]);
  window.history.replaceState(null, '', '/quest/q1/about?promo=GEO-7KX2M9');
});

describe('AboutClient — QR invitation', () => {
  it('offers the quest as a gift and gives it in one tap — no sheet, no sign-in first', async () => {
    checkoutMock.mockResolvedValue({ grant: { quest_id: 'q1' }, created: true });
    render(<AboutClient questId="q1" />);

    // The order card and the phone's banner both carry the gift.
    expect(await screen.findAllByText('Квест в подарок')).toHaveLength(2);
    expect(screen.getAllByText('Подарок от хостела Fortress')).toHaveLength(2);
    expect(screen.getAllByText('Приглашение действует до 30.11.2026')).toHaveLength(2);
    expect(validateMock).toHaveBeenCalledWith({ user_id: 'dev:guest', quest_id: 'q1', code: 'GEO-7KX2M9' });
    // The code left the address bar (kept for this tab) and no sign-in is asked.
    expect(window.location.search).toBe('');
    expect(screen.queryByText(/войдите/)).toBeNull();
    expect(screen.queryByText('Оплата картой российского банка.')).toBeNull();

    fireEvent.click(screen.getAllByRole('button', { name: 'Получить бесплатно' })[0]);

    await screen.findByText('Подарок получен — квест ваш навсегда.');
    expect(checkoutMock).toHaveBeenCalledWith({ user_id: 'dev:guest', quest_id: 'q1', coupon_code: 'GEO-7KX2M9' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByText('✓ Квест ваш')).toBeTruthy();
    // Only now is the account offered.
    expect(screen.getByText('Сохраните квест в аккаунте')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'или по почте' }).getAttribute('href')).toBe(
      '/auth?next=%2Fquest%2Fq1%2Fabout',
    );
    expect(window.sessionStorage.length).toBe(0);
  });

  it('keeps the code for the tab: a return without ?promo= still finds the gift', async () => {
    window.history.replaceState(null, '', '/quest/q1/about');
    window.sessionStorage.setItem('geohod-promo:v1:q1', 'GEO-7KX2M9');
    render(<AboutClient questId="q1" />);
    expect(await screen.findAllByText('Квест в подарок')).toHaveLength(2);
  });

  it('a partial discount opens the purchase sheet with the code already applied', async () => {
    validateMock.mockResolvedValue({ ...GIFT, discount_amount: 450, final_price: 450, gift_from: null });
    render(<AboutClient questId="q1" />);
    expect(await screen.findAllByText('Скидка по приглашению')).toHaveLength(2);
    fireEvent.click(screen.getByRole('button', { name: 'Купить за 450 ₽' }));
    const sheet = await screen.findByRole('dialog');
    expect(await within(sheet).findByText('Промокод −450 ₽')).toBeTruthy();
    expect(checkoutMock).not.toHaveBeenCalled();
  });

  it('an ended invitation says so, suggests the free quest of the city and still sells', async () => {
    validateMock.mockResolvedValue(ENDED);
    listQuestsMock.mockResolvedValue([
      { quest_id: 'irony', name: 'Ирония Судьбы', city: 'Нови Сад', price: 0, players: 330 },
      { quest_id: 'fortress', name: 'Тайна крепости', city: 'Нови Сад', price: 0, players: 477 },
    ]);
    render(<AboutClient questId="q1" />);
    expect(await screen.findAllByText('Приглашение закончилось')).toHaveLength(2);
    const [link] = await screen.findAllByRole('link', { name: '«Тайна крепости»' });
    expect(link.getAttribute('href')).toBe('/quest/fortress/about');
    expect(screen.getByRole('button', { name: 'Купить за 900 ₽' })).toBeTruthy();
  });

  it('a gift that ran out between the preview and the tap says why, not «try again»', async () => {
    checkoutMock.mockRejectedValue(
      new ApiError(409, '/api/checkout', '{"error":"Промокод больше не действует — лимит исчерпан"}'),
    );
    render(<AboutClient questId="q1" />);
    fireEvent.click((await screen.findAllByRole('button', { name: 'Получить бесплатно' }))[0]);
    validateMock.mockResolvedValue(ENDED);
    expect(await screen.findAllByText('Приглашение закончилось')).toHaveLength(2);
    expect(screen.queryByText(/Не получилось оформить покупку/)).toBeNull();
  });

  it('an owner sees «Квест ваш»: nothing is priced, the invitation is not spent', async () => {
    listGrantsMock.mockResolvedValue([{ quest_id: 'q1', user_id: 'dev:guest' }]);
    render(<AboutClient questId="q1" />);
    await screen.findByText('✓ Квест ваш');
    expect(validateMock).not.toHaveBeenCalled();
    expect(screen.queryByText('Квест в подарок')).toBeNull();
  });

  it('with the flag off the code is ignored and the page sells as usual', async () => {
    flags.promo = false;
    render(<AboutClient questId="q1" />);
    await screen.findByRole('heading', { level: 1, name: 'Потерянный друг' });
    expect(screen.getByRole('button', { name: 'Купить за 900 ₽' })).toBeTruthy();
    expect(validateMock).not.toHaveBeenCalled();
    expect(screen.queryByText('Квест в подарок')).toBeNull();
  });
});
