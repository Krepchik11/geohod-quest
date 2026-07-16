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
const { checkoutMock, validateMock, providersMock, paymentStatusMock, sessionRef } = vi.hoisted(
  () => ({
    checkoutMock: vi.fn(),
    validateMock: vi.fn(),
    providersMock: vi.fn(),
    paymentStatusMock: vi.fn(),
    sessionRef: { current: null as null | { token: string } },
  }),
);
vi.mock('../../../lib/api', () => ({
  api: {
    checkout: checkoutMock,
    validateCoupon: validateMock,
    paymentProviders: providersMock,
    paymentStatus: paymentStatusMock,
  },
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
  providersMock.mockReset();
  paymentStatusMock.mockReset();
  // Default deployment: mock-only — no method selector, historical behavior.
  providersMock.mockResolvedValue({ providers: ['mock'] });
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

describe('PurchaseSheet — ЮKassa redirect', () => {
  const BOTH = { providers: ['mock', 'yookassa'] };

  it('mock-only deployments render no method selector', async () => {
    setup();
    await waitFor(() => expect(providersMock).toHaveBeenCalled());
    expect(screen.queryByRole('radiogroup', { name: 'Способ оплаты' })).toBeNull();
  });

  it('offers the method choice and defaults to the card when ЮKassa exists', async () => {
    providersMock.mockResolvedValue(BOTH);
    setup();
    const card = await screen.findByRole('radio', { name: /Банковская карта/ });
    expect(card.getAttribute('aria-checked')).toBe('true');
    expect(screen.getByRole('radio', { name: /Тестовая оплата/ }).getAttribute('aria-checked')).toBe('false');
    expect(screen.getByRole('button', { name: 'Оплатить 890 ₽' })).toBeTruthy();
  });

  it('confirming the card method sends provider=yookassa and redirects to the gateway', async () => {
    providersMock.mockResolvedValue(BOTH);
    checkoutMock.mockResolvedValue({
      payment: { payment_id: 'pay-1', confirmation_url: 'https://yookassa.ru/confirm/x' },
    });
    const assign = vi.fn();
    const original = window.location;
    Object.defineProperty(window, 'location', {
      value: { ...original, assign },
      writable: true,
      configurable: true,
    });
    try {
      const { onPurchased } = setup();
      fireEvent.click(await screen.findByRole('button', { name: 'Оплатить 890 ₽' }));
      await waitFor(() => expect(assign).toHaveBeenCalledWith('https://yookassa.ru/confirm/x'));
      expect(checkoutMock).toHaveBeenCalledWith({
        player_id: 'dev:test',
        quest_id: 'q1',
        provider: 'yookassa',
      });
      // No premature success: settlement happens on the return page.
      expect(onPurchased).not.toHaveBeenCalled();
      expect(screen.getByText('Переходим к оплате…')).toBeTruthy();
    } finally {
      Object.defineProperty(window, 'location', { value: original, writable: true, configurable: true });
    }
  });

  /** Drive the sheet into the 'redirect' lock, then simulate the browser Back
   *  button restoring the page from the bfcache (pageshow with persisted). */
  async function redirectThenComeBack() {
    providersMock.mockResolvedValue(BOTH);
    checkoutMock.mockResolvedValue({
      payment: { payment_id: 'pay-1', confirmation_url: 'https://yookassa.ru/confirm/x' },
    });
    const assign = vi.fn();
    const original = window.location;
    Object.defineProperty(window, 'location', {
      value: { ...original, assign },
      writable: true,
      configurable: true,
    });
    const restore = () =>
      Object.defineProperty(window, 'location', {
        value: original,
        writable: true,
        configurable: true,
      });
    const hosts = setup();
    fireEvent.click(await screen.findByRole('button', { name: 'Оплатить 890 ₽' }));
    await waitFor(() => expect(assign).toHaveBeenCalled());
    const pageshow = new Event('pageshow');
    Object.defineProperty(pageshow, 'persisted', { value: true });
    window.dispatchEvent(pageshow);
    return { ...hosts, restore };
  }

  it('browser Back with a settled payment completes the purchase', async () => {
    paymentStatusMock.mockResolvedValue({ status: 'succeeded', grant: {} });
    const { onPurchased, restore } = await redirectThenComeBack();
    try {
      await waitFor(() => expect(onPurchased).toHaveBeenCalled());
      expect(paymentStatusMock).toHaveBeenCalledWith('pay-1');
    } finally {
      restore();
    }
  });

  it('browser Back with the payment still pending unlocks the sheet for a retry', async () => {
    paymentStatusMock.mockResolvedValue({ status: 'pending', grant: null });
    const { onPurchased, restore } = await redirectThenComeBack();
    try {
      await waitFor(() =>
        expect(screen.getByText(/Оплата не завершена/)).toBeTruthy(),
      );
      // The lock is gone: pay and cancel are live again.
      expect(screen.getByRole('button', { name: 'Оплатить 890 ₽' })).toBeTruthy();
      const cancel = screen.getByRole('button', { name: 'Отмена' }) as HTMLButtonElement;
      expect(cancel.disabled).toBe(false);
      expect(onPurchased).not.toHaveBeenCalled();
    } finally {
      restore();
    }
  });

  it('browser Back after a canceled payment unlocks the sheet and says so', async () => {
    paymentStatusMock.mockResolvedValue({ status: 'canceled', grant: null });
    const { onPurchased, restore } = await redirectThenComeBack();
    try {
      await waitFor(() => expect(screen.getByText(/Оплата отменена/)).toBeTruthy());
      expect(screen.getByRole('button', { name: 'Оплатить 890 ₽' })).toBeTruthy();
      expect(onPurchased).not.toHaveBeenCalled();
    } finally {
      restore();
    }
  });

  it('switching to the test method keeps the historical instant flow', async () => {
    providersMock.mockResolvedValue(BOTH);
    checkoutMock.mockResolvedValue({ grant: {}, created: true });
    const { onPurchased } = setup();
    fireEvent.click(await screen.findByRole('radio', { name: /Тестовая оплата/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Подтвердить — 890 ₽' }));
    await waitFor(() => expect(onPurchased).toHaveBeenCalled());
    expect(checkoutMock).toHaveBeenCalledWith({ player_id: 'dev:test', quest_id: 'q1' });
  });
});
