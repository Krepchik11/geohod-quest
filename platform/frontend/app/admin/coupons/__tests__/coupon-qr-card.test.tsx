// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import React from 'react';
import type { AdminCoupon } from '../../../../lib/admin-coupons';

/**
 * The coupon editor's «QR-код» card: a QR only for a coupon
 * limited to one quest; «Сделать QR-код» asks the server for the permanent
 * address once; with it — the QR, its short link, the downloads and the
 * invitation funnel; a coupon widened past one quest warns that its printed
 * QR stopped working.
 */
const { createQrMock, funnelMock } = vi.hoisted(() => ({
  createQrMock: vi.fn(),
  funnelMock: vi.fn(),
}));
vi.mock('../../../../lib/api', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  api: { adminCreateCouponQr: createQrMock, adminCouponFunnel: funnelMock },
}));

import CouponQrCard from '../CouponQrCard';

function coupon(over: Partial<AdminCoupon> = {}): AdminCoupon {
  return {
    id: 'cpn-1',
    code: 'GEO-AB12CD',
    discountType: 'percent',
    discountValue: 100,
    validUntil: '2026-11-30',
    maxRedemptions: 30,
    perUserLimit: 1,
    questIds: ['q1'],
    paused: false,
    status: 'active',
    used: 0,
    lastRedeemedAt: null,
    totalDiscounted: 0,
    createdAt: '2026-10-31T00:00:00Z',
    giftFrom: null,
    qrSlug: null,
    ...over,
  };
}

const FUNNEL = { scans: 12, got: 5, started: 4, finished: 3, rated: 2, bought: 1 };

beforeEach(() => {
  createQrMock.mockReset();
  funnelMock.mockReset().mockResolvedValue(FUNNEL);
});

describe('CouponQrCard', () => {
  it('explains that a QR needs a coupon for one quest', () => {
    render(<CouponQrCard coupon={coupon({ questIds: null })} onCoupon={vi.fn()} onToast={vi.fn()} />);
    expect(screen.getByText(/QR-код делается для купона на один квест/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Сделать QR-код' })).toBeNull();
  });

  it('makes the QR on request and hands the coupon with its address back', async () => {
    createQrMock.mockResolvedValue({
      coupon_id: 'cpn-1', code: 'GEO-AB12CD', discount_type: 'percent', discount_value: 100,
      valid_until: '2026-11-30', max_redemptions: 30, per_user_limit: 1, quest_ids: ['q1'],
      paused: false, created_at: '2026-10-31T00:00:00Z', gift_from: null, qr_slug: '7KX2M9',
      status: 'active', used: 0, last_redeemed_at: null, total_discounted: 0,
    });
    const onCoupon = vi.fn();
    render(<CouponQrCard coupon={coupon()} onCoupon={onCoupon} onToast={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Сделать QR-код' }));
    await waitFor(() => expect(onCoupon).toHaveBeenCalled());
    expect(createQrMock).toHaveBeenCalledWith('cpn-1');
    expect(onCoupon.mock.calls[0][0].qrSlug).toBe('7KX2M9');
  });

  it('shows the QR, its short link, the downloads and the funnel', async () => {
    render(<CouponQrCard coupon={coupon({ qrSlug: '7KX2M9' })} onCoupon={vi.fn()} onToast={vi.fn()} />);
    const img = await screen.findByRole('img', { name: /QR-код ссылки .*\/go\/7KX2M9$/ });
    expect(img.getAttribute('src')).toMatch(/^data:image\/svg\+xml/);
    expect(screen.getByText(/\/go\/7KX2M9$/).tagName).toBe('CODE');
    for (const name of ['Скачать PNG', 'Скачать SVG', 'Скопировать ссылку']) {
      expect(screen.getByRole('button', { name })).toBeTruthy();
    }
    await screen.findByText('Купили другой квест');
    expect(funnelMock).toHaveBeenCalledWith('cpn-1');
    expect(screen.getByText('Сканы').nextElementSibling?.textContent).toBe('12');
    expect(screen.getByText('Купили другой квест').nextElementSibling?.textContent).toBe('1');
  });

  it('warns that a QR printed for a coupon now wider than one quest does not work', () => {
    render(
      <CouponQrCard coupon={coupon({ qrSlug: '7KX2M9', questIds: ['q1', 'q2'] })} onCoupon={vi.fn()} onToast={vi.fn()} />,
    );
    expect(screen.getByRole('alert').textContent).toMatch(/QR-код сейчас не работает/);
  });
});
