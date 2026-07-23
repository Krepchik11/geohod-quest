// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import React from 'react';

/**
 * §3 product page flows: model-data rendering, not-owned → sheet → owned in
 * place (no redirect), free instant grant, delisted quest 404 state, chips
 * hidden when unknown, reviews aggregate until §11.
 */
const { getProductMock, listGrantsMock, checkoutMock, downloadMock, pollMock } = vi.hoisted(() => ({
  getProductMock: vi.fn(),
  listGrantsMock: vi.fn(),
  checkoutMock: vi.fn(),
  downloadMock: vi.fn(async () => ({})),
  pollMock: vi.fn(),
}));
vi.mock('../../../../../lib/api', () => ({
  api: {
    getQuestProduct: getProductMock,
    listGrants: listGrantsMock,
    checkout: checkoutMock,
    getBundle: vi.fn(),
    paymentProviders: vi.fn().mockResolvedValue({ providers: ['mock'] }),
  },
}));
vi.mock('../../../../../lib/identity', () => ({
  currentPlayerId: () => 'dev:test',
  getSession: () => null,
  subscribeSession: () => () => {},
}));
vi.mock('../../../../../lib/download', () => ({ downloadBundle: downloadMock }));
vi.mock('../../../../../lib/payment-return', () => ({ pollPaymentSettlement: pollMock }));

import AboutClient, { productChips } from '../AboutClient';

const PRODUCT = {
  quest_id: 'q1', name: 'Тайны старого Белграда', primary_comic: null,
  template_summary: '', snapshot_version: 4, snapshot_id: 's4',
  city: 'Белград, Дорчол', duration: '2–3 часа', price: 890,
  rating_avg: 4.8, rating_count: 24,
  description: 'Прогулка по кварталам.', author_name: 'Мария К.',
  author_published_count: 3, pages: 12, tasks: 4, paid_hints: true,
  reviews: [], reviews_total: 0,
  start_point: null,
};

beforeEach(() => {
  getProductMock.mockReset().mockResolvedValue(PRODUCT);
  listGrantsMock.mockReset().mockResolvedValue([]);
  checkoutMock.mockReset();
  downloadMock.mockClear();
  pollMock.mockReset();
  window.history.replaceState(null, '', '/quest/q1/about');
});

describe('productChips', () => {
  it('derives honest chips and hides unknown ones', () => {
    expect(productChips({ pages: 12, tasks: 4, paid_hints: true })).toEqual([
      '12 страниц', '4 задания', 'подсказки за монеты', 'работает офлайн',
    ]);
    expect(productChips({ pages: null, tasks: null, paid_hints: null })).toEqual(['работает офлайн']);
  });
});

describe('AboutClient', () => {
  it('renders model data: breadcrumb, meta, description, author, chips', async () => {
    render(<AboutClient questId="q1" />);
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Тайны старого Белграда' })).toBeTruthy());
    expect(screen.getByText('Магазин квестов')).toBeTruthy();
    expect(screen.getByText('Прогулка по кварталам.')).toBeTruthy();
    expect(screen.getByText('Мария К.')).toBeTruthy();
    expect(screen.getByText('3 квеста в магазине')).toBeTruthy();
    expect(screen.getByText('12 страниц')).toBeTruthy();
    expect(screen.getByText(/★ 4.8 · 24 оценки/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Купить за 890 ₽' })).toBeTruthy();
  });

  it('«Купить» opens the sheet; confirm flips the order card in place + auto-downloads', async () => {
    checkoutMock.mockResolvedValue({});
    render(<AboutClient questId="q1" />);
    await waitFor(() => screen.getByRole('button', { name: 'Купить за 890 ₽' }));
    fireEvent.click(screen.getByRole('button', { name: 'Купить за 890 ₽' }));
    expect(screen.getByText('Подтвердите покупку')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Подтвердить — 890 ₽' }));
    await waitFor(() => expect(screen.getByText('✓ Квест куплен')).toBeTruthy());
    expect(screen.getByRole('link', { name: 'Пройти квест' }).getAttribute('href')).toBe('/quest/q1');
    expect(downloadMock).toHaveBeenCalled();
  });

  it('already-owned quest renders the owned card straight away', async () => {
    listGrantsMock.mockResolvedValue([{ player_id: 'dev:test', quest_id: 'q1' }]);
    render(<AboutClient questId="q1" />);
    await waitFor(() => expect(screen.getByText('✓ Квест куплен')).toBeTruthy());
  });

  it('free quest grants instantly without the sheet', async () => {
    getProductMock.mockResolvedValue({ ...PRODUCT, price: 0 });
    checkoutMock.mockResolvedValue({});
    render(<AboutClient questId="q1" />);
    await waitFor(() => screen.getAllByRole('button', { name: 'Получить' }));
    fireEvent.click(screen.getAllByRole('button', { name: 'Получить' })[0]);
    await waitFor(() => expect(screen.getByText('✓ Квест куплен')).toBeTruthy());
    expect(screen.queryByText('Подтвердите покупку')).toBeNull();
  });

  it('«Место старта» links to system maps at the quest start point', async () => {
    getProductMock.mockResolvedValue({
      ...PRODUCT,
      start_point: { lat: 44.8176, lng: 20.4569, label: 'Калемегдан' },
    });
    render(<AboutClient questId="q1" />);
    await waitFor(() => expect(screen.getByRole('link', { name: /Место старта/ })).toBeTruthy());
    const link = screen.getByRole('link', { name: /Место старта — Калемегдан/ });
    expect(link.getAttribute('href')).toBe(
      'https://www.google.com/maps/search/?api=1&query=44.8176,20.4569',
    );
    expect(link.getAttribute('target')).toBe('_blank');
  });

  it('no coordinates in the quest — no «Место старта» button', async () => {
    render(<AboutClient questId="q1" />);
    await waitFor(() => screen.getByRole('heading', { name: 'Тайны старого Белграда' }));
    expect(screen.queryByRole('link', { name: /Место старта/ })).toBeNull();
  });

  it('a 404 product renders the honest gone state', async () => {
    getProductMock.mockRejectedValue({ status: 404 });
    render(<AboutClient questId="qX" />);
    await waitFor(() => expect(screen.getByText('Этого квеста больше нет в магазине.')).toBeTruthy());
  });

  it('renders §11 reviews: first name, month, stars, text', async () => {
    getProductMock.mockResolvedValue({
      ...PRODUCT,
      reviews: [{ author: 'Аня', rating: 5, text: 'Прошли вдвоём за вечер, финал — мурашки.', created_at: 1781200000 }],
      reviews_total: 1,
    });
    render(<AboutClient questId="q1" />);
    await waitFor(() => expect(screen.getByText('Аня')).toBeTruthy());
    expect(screen.getByText('Прошли вдвоём за вечер, финал — мурашки.')).toBeTruthy();
    expect(screen.getByLabelText('Оценка 5 из 5')).toBeTruthy();
    expect(screen.getByText(/1 с отзывом/)).toBeTruthy();
  });

  it('empty rating shows the reviews empty state', async () => {
    getProductMock.mockResolvedValue({ ...PRODUCT, rating_avg: 0, rating_count: 0 });
    render(<AboutClient questId="q1" />);
    await waitFor(() => expect(screen.getByText('Пока без отзывов — станьте первым')).toBeTruthy());
  });
});

describe('AboutClient — ЮKassa return (?payment={id})', () => {
  it('succeeded: settles via the poll, flips to owned, auto-downloads, strips the param', async () => {
    pollMock.mockResolvedValue('succeeded');
    window.history.replaceState(null, '', '/quest/q1/about?payment=pay-1');
    render(<AboutClient questId="q1" />);
    await waitFor(() => expect(screen.getByText('✓ Квест куплен')).toBeTruthy());
    expect(pollMock).toHaveBeenCalledWith('pay-1');
    expect(screen.getByText('Оплата прошла — квест ваш навсегда.')).toBeTruthy();
    expect(downloadMock).toHaveBeenCalled();
    expect(window.location.search).toBe('');
  });

  it('canceled: «деньги не списаны» + the quest stays purchasable', async () => {
    pollMock.mockResolvedValue('canceled');
    window.history.replaceState(null, '', '/quest/q1/about?payment=pay-1');
    render(<AboutClient questId="q1" />);
    await waitFor(() =>
      expect(screen.getByText(/Оплата не прошла — деньги не списаны/)).toBeTruthy(),
    );
    expect(screen.getByRole('button', { name: 'Купить за 890 ₽' })).toBeTruthy();
    expect(downloadMock).not.toHaveBeenCalled();
  });

  it('still pending after the schedule: honest processing note, no grant claimed', async () => {
    pollMock.mockResolvedValue('pending');
    window.history.replaceState(null, '', '/quest/q1/about?payment=pay-1');
    render(<AboutClient questId="q1" />);
    await waitFor(() => expect(screen.getByText(/Платёж ещё обрабатывается/)).toBeTruthy());
    expect(screen.queryByText('✓ Квест куплен')).toBeNull();
  });
});
