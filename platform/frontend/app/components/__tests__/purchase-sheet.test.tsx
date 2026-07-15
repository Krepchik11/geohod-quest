// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import React from 'react';

/**
 * §3.3 purchase confirmation sheet. Pinned behaviors:
 * - contents in order: title, quest row, price row, collapsed promo, anon
 *   warning (ONLY for anonymous), confirm + cancel;
 * - promo codes are validated SERVER-SIDE (api.validateCoupon) — a confirmed
 *   code shows the priced discount with the old price struck through, a
 *   rejected one shows the backend's message;
 * - confirm calls api.checkout and reports success via onPurchased (§3.4: stay
 *   in place — the sheet closes, the caller flips to owned);
 * - failure shows the in-sheet error box + «Повторить — {price} ₽»;
 * - charging happens ONLY on confirm.
 */
const { checkoutMock, validateMock, sessionRef } = vi.hoisted(() => ({
  checkoutMock: vi.fn(),
  validateMock: vi.fn(),
  sessionRef: { current: null as null | { token: string } },
}));
vi.mock('../../../lib/api', () => ({
  api: { checkout: checkoutMock, validateCoupon: validateMock },
}));
vi.mock('../../../lib/identity', () => ({
  currentPlayerId: () => 'dev:test',
  getSession: () => sessionRef.current,
  subscribeSession: () => () => {},
}));

import PurchaseSheet from '../PurchaseSheet';

const QUEST = {
  quest_id: 'q1',
  name: 'Тайны старого Белграда',
  city: 'Белград',
  duration: '2–3 часа',
  price: 890,
  primary_comic: null,
};

function setup() {
  const onClose = vi.fn();
  const onPurchased = vi.fn();
  render(<PurchaseSheet quest={QUEST} onClose={onClose} onPurchased={onPurchased} />);
  return { onClose, onPurchased };
}

beforeEach(() => {
  checkoutMock.mockReset();
  validateMock.mockReset();
  sessionRef.current = null;
});

describe('PurchaseSheet', () => {
  it('portals to document.body — never a descendant of the caller DOM', () => {
    // A card ancestor gains transform on :hover, which would make it the
    // containing block for the fixed overlay and clip the sheet inside the
    // card. Portaling to <body> removes that whole bug class.
    const { container } = render(
      <PurchaseSheet quest={QUEST} onClose={() => {}} onPurchased={() => {}} />,
    );
    expect(container.querySelector('.psheet__ovl')).toBeNull();
    const overlay = document.body.querySelector('.psheet__ovl');
    expect(overlay).toBeTruthy();
    expect(overlay!.parentElement).toBe(document.body);
  });

  it('renders the confirmation anatomy without charging', () => {
    setup();
    expect(screen.getByText('Подтвердите покупку')).toBeTruthy();
    expect(screen.getByText('Тайны старого Белграда')).toBeTruthy();
    expect(screen.getByText('Белград · 2–3 часа · доступ навсегда')).toBeTruthy();
    expect(screen.getByText('К оплате')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Подтвердить — 890 ₽' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Отмена' })).toBeTruthy();
    expect(checkoutMock).not.toHaveBeenCalled();
  });

  it('warns the anonymous buyer with a login link; signed-in users see no warning', () => {
    const { unmount } = render(
      <PurchaseSheet quest={QUEST} onClose={() => {}} onPurchased={() => {}} />,
    );
    expect(screen.getByText(/Вы не вошли: покупка привяжется к этому устройству/)).toBeTruthy();
    unmount();
    sessionRef.current = { token: 't' };
    render(<PurchaseSheet quest={QUEST} onClose={() => {}} onPurchased={() => {}} />);
    expect(screen.queryByText(/Вы не вошли/)).toBeNull();
  });

  it('reveals the promo input and applies a server-confirmed code', async () => {
    validateMock.mockResolvedValue({
      valid: true,
      code: 'GEO-20',
      price: 890,
      discount_amount: 178,
      final_price: 712,
    });
    setup();
    fireEvent.click(screen.getByText('Есть промокод?'));
    fireEvent.change(screen.getByPlaceholderText('Промокод'), { target: { value: 'geo-20' } });
    fireEvent.click(screen.getByRole('button', { name: 'Применить' }));
    await waitFor(() => expect(screen.getByText('Промокод −178 ₽')).toBeTruthy());
    expect(validateMock).toHaveBeenCalledWith({
      player_id: 'dev:test',
      quest_id: 'q1',
      code: 'geo-20',
    });
    expect(screen.getByText('890 ₽').tagName).toBe('S'); // old price struck through
    expect(screen.getByRole('button', { name: 'Подтвердить — 712 ₽' })).toBeTruthy();
  });

  it('shows the backend message for a rejected code and keeps the full price', async () => {
    validateMock.mockResolvedValue({ valid: false, message: 'Срок действия промокода истёк' });
    setup();
    fireEvent.click(screen.getByText('Есть промокод?'));
    fireEvent.change(screen.getByPlaceholderText('Промокод'), { target: { value: 'OLD-10' } });
    fireEvent.click(screen.getByRole('button', { name: 'Применить' }));
    await waitFor(() => expect(screen.getByText('Срок действия промокода истёк')).toBeTruthy());
    expect(screen.getByRole('button', { name: 'Подтвердить — 890 ₽' })).toBeTruthy();
  });

  it('confirm charges once and reports success', async () => {
    checkoutMock.mockResolvedValue({});
    const { onPurchased } = setup();
    fireEvent.click(screen.getByRole('button', { name: 'Подтвердить — 890 ₽' }));
    await waitFor(() => expect(onPurchased).toHaveBeenCalled());
    expect(checkoutMock).toHaveBeenCalledWith({ player_id: 'dev:test', quest_id: 'q1' });
  });

  it('passes coupon_code when a promo is applied', async () => {
    validateMock.mockResolvedValue({
      valid: true,
      code: 'GEO-20',
      price: 890,
      discount_amount: 178,
      final_price: 712,
    });
    checkoutMock.mockResolvedValue({});
    const { onPurchased } = setup();
    fireEvent.click(screen.getByText('Есть промокод?'));
    fireEvent.change(screen.getByPlaceholderText('Промокод'), { target: { value: 'GEO-20' } });
    fireEvent.click(screen.getByRole('button', { name: 'Применить' }));
    const confirmBtn = await screen.findByRole('button', { name: 'Подтвердить — 712 ₽' });
    fireEvent.click(confirmBtn);
    await waitFor(() => expect(onPurchased).toHaveBeenCalled());
    expect(checkoutMock).toHaveBeenCalledWith({
      player_id: 'dev:test',
      quest_id: 'q1',
      coupon_code: 'GEO-20',
    });
  });

  it('failure shows the in-sheet error and «Повторить» retries', async () => {
    checkoutMock.mockRejectedValueOnce(new Error('net')).mockResolvedValueOnce({});
    const { onPurchased } = setup();
    fireEvent.click(screen.getByRole('button', { name: 'Подтвердить — 890 ₽' }));
    await waitFor(() =>
      expect(screen.getByText(/Не получилось оформить покупку — проверьте связь/)).toBeTruthy(),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Повторить — 890 ₽' }));
    await waitFor(() => expect(onPurchased).toHaveBeenCalled());
    expect(checkoutMock).toHaveBeenCalledTimes(2);
  });

  it('«Отмена» closes without charging', () => {
    const { onClose } = setup();
    fireEvent.click(screen.getByRole('button', { name: 'Отмена' }));
    expect(onClose).toHaveBeenCalled();
    expect(checkoutMock).not.toHaveBeenCalled();
  });
});
