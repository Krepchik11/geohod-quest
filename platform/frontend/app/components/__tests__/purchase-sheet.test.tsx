// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import React from 'react';

/**
 * §3.3 purchase confirmation sheet. Pinned behaviors:
 * - contents in order: title, quest row, price row, collapsed promo, anon
 *   warning (ONLY for anonymous), confirm + cancel;
 * - promo «CODE-N» applies −N% with the old price struck through;
 * - confirm calls api.checkout and reports success via onPurchased (§3.4: stay
 *   in place — the sheet closes, the caller flips to owned);
 * - failure shows the in-sheet error box + «Повторить — {price} ₽»;
 * - charging happens ONLY on confirm.
 */
const { checkoutMock, sessionRef } = vi.hoisted(() => ({
  checkoutMock: vi.fn(),
  sessionRef: { current: null as null | { token: string } },
}));
vi.mock('../../../lib/api', () => ({ api: { checkout: checkoutMock } }));
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
  sessionRef.current = null;
});

describe('PurchaseSheet', () => {
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

  it('reveals the promo input and applies a −20% code', () => {
    setup();
    fireEvent.click(screen.getByText('Есть промокод?'));
    fireEvent.change(screen.getByPlaceholderText('Промокод'), { target: { value: 'GEO-20' } });
    fireEvent.click(screen.getByRole('button', { name: 'Применить' }));
    expect(screen.getByText('Промокод −20%')).toBeTruthy();
    expect(screen.getByText('890 ₽').tagName).toBe('S'); // old price struck through
    expect(screen.getByRole('button', { name: 'Подтвердить — 712 ₽' })).toBeTruthy();
  });

  it('confirm charges once and reports success', async () => {
    checkoutMock.mockResolvedValue({});
    const { onPurchased } = setup();
    fireEvent.click(screen.getByRole('button', { name: 'Подтвердить — 890 ₽' }));
    await waitFor(() => expect(onPurchased).toHaveBeenCalled());
    expect(checkoutMock).toHaveBeenCalledWith({ player_id: 'dev:test', quest_id: 'q1' });
  });

  it('passes coupon_percent when a promo is applied', async () => {
    checkoutMock.mockResolvedValue({});
    const { onPurchased } = setup();
    fireEvent.click(screen.getByText('Есть промокод?'));
    fireEvent.change(screen.getByPlaceholderText('Промокод'), { target: { value: 'GEO-20' } });
    fireEvent.click(screen.getByRole('button', { name: 'Применить' }));
    fireEvent.click(screen.getByRole('button', { name: 'Подтвердить — 712 ₽' }));
    await waitFor(() => expect(onPurchased).toHaveBeenCalled());
    expect(checkoutMock).toHaveBeenCalledWith({ player_id: 'dev:test', quest_id: 'q1', coupon_percent: 20 });
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
