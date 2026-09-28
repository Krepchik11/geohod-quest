// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import React from 'react';

/**
 * Admin · Отзывы page. Pinned behaviors: the list renders every rating (star-only
 * included) with the resolved contact, newest first unless another sort is picked;
 * every filter option carries its count; filters, search and sort round-trip
 * through the URL; a picked quest gets its on-site summary; the list renders fifty
 * at a time; account holders link to Пользователи and any author id copies; hiding
 * a review confirms with a before→after average preview (same grain the
 * server folds), calls the hide endpoint, and drops the row from the shown list.
 * (Access gating lives in the route layout — see layout.test.tsx; the page itself
 * renders assuming access.)
 */
const { listMock, hideMock, unhideMock } = vi.hoisted(() => ({
  listMock: vi.fn(),
  hideMock: vi.fn(),
  unhideMock: vi.fn(),
}));
vi.mock('../../../lib/api', () => ({
  api: {
    adminListReviews: listMock,
    adminHideReview: hideMock,
    adminUnhideReview: unhideMock,
  },
}));

import AdminReviewsPage from '../reviews/page';
import { type AdminIdentityWire } from '../../../lib/api';

const id = (over: Partial<AdminIdentityWire>): AdminIdentityWire => ({
  user_id: 'dev:1',
  display_name: null,
  kind: 'anon',
  email: null,
  telegram_username: null,
  ...over,
});

const REVIEWS = {
  reviews: [
    {
      quest_id: 'q1',
      quest_name: 'Ирония судьбы',
      quest_city: 'Казань',
      rating: 5,
      text: 'Отлично',
      created_at: 100,
      hidden: false,
      identity: id({ user_id: 'acct:anna', display_name: 'Анна', kind: 'google', email: 'anna@gmail.com' }),
    },
    {
      quest_id: 'q1',
      quest_name: 'Ирония судьбы',
      quest_city: 'Казань',
      rating: 4,
      text: null,
      created_at: 90,
      hidden: false,
      identity: id({ user_id: 'acct:milan', display_name: 'Milan', kind: 'telegram', telegram_username: 'milan_bg' }),
    },
    {
      quest_id: 'q1',
      quest_name: 'Ирония судьбы',
      quest_city: 'Казань',
      rating: 2,
      text: null,
      created_at: 80,
      hidden: false,
      identity: id({ user_id: 'dev:anon', kind: 'anon' }),
    },
  ],
};

/** Author names in on-screen order. */
const order = (container: HTMLElement) =>
  [...container.querySelectorAll('.amod-card__name')].map((n) => n.textContent);

beforeEach(() => {
  window.history.replaceState(null, '', '/admin/reviews');
  listMock.mockReset();
  hideMock.mockReset();
  unhideMock.mockReset();
  listMock.mockResolvedValue(REVIEWS);
  hideMock.mockResolvedValue({});
  unhideMock.mockResolvedValue({});
});

describe('AdminReviewsPage', () => {
  it('renders ratings incl. star-only, contacts, and the count line', async () => {
    render(<AdminReviewsPage />);
    expect(await screen.findByText('Отлично')).toBeTruthy();
    // Two star-only ratings render the italic note.
    expect(screen.getAllByText('Оценка без отзыва — учитывается только в средней.').length).toBe(2);
    // Contacts resolve per kind.
    expect(screen.getByText('anna@gmail.com')).toBeTruthy();
    expect(screen.getByText('@milan_bg')).toBeTruthy();
    expect(screen.getByText('аноним · контакта нет')).toBeTruthy();
    expect(screen.getByText('3 записи')).toBeTruthy();
  });

  it('lists newest first by default and re-sorts from the select into the URL', async () => {
    const { container } = render(<AdminReviewsPage />);
    await screen.findByText('Отлично');
    expect(order(container)).toEqual(['Анна', 'Milan', 'Гость']);
    fireEvent.change(screen.getByLabelText('Сортировка'), { target: { value: 'worst' } });
    expect(order(container)).toEqual(['Гость', 'Milan', 'Анна']);
    expect(window.location.search).toBe('?sort=worst');
    fireEvent.change(screen.getByLabelText('Сортировка'), { target: { value: 'best' } });
    expect(order(container)).toEqual(['Анна', 'Milan', 'Гость']);
  });

  it('counts every filter option and disables the empty ratings', async () => {
    listMock.mockResolvedValue({
      reviews: [...REVIEWS.reviews.slice(0, 2), { ...REVIEWS.reviews[2], hidden: true }],
    });
    render(<AdminReviewsPage />);
    await screen.findByText('Отлично');
    expect(screen.getByText('Видимые · 2')).toBeTruthy();
    expect(screen.getByText('Скрытые · 1')).toBeTruthy();
    expect(screen.getByText('Все · 3')).toBeTruthy();
    // Rating counts follow the view: the hidden 2★ is not among the visible ones.
    expect((screen.getByText('5★ · 1') as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByText('2★ · 0') as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole('option', { name: 'Ирония судьбы · 2' })).toBeTruthy();
    expect(screen.getByText('С текстом · 1')).toBeTruthy();
    expect(screen.getByText('Только звёзды · 1')).toBeTruthy();
  });

  it('searches the text and the author into the URL, counts included', async () => {
    const { container } = render(<AdminReviewsPage />);
    await screen.findByText('Отлично');
    const box = screen.getByLabelText('Поиск по отзывам');
    fireEvent.change(box, { target: { value: '@MILAN' } });
    await waitFor(() => expect(order(container)).toEqual(['Milan']));
    expect(window.location.search).toBe('?q=%40MILAN');
    expect(screen.getByText('Видимые · 1')).toBeTruthy();
    fireEvent.change(box, { target: { value: 'отлично' } });
    await waitFor(() => expect(order(container)).toEqual(['Анна']));
    fireEvent.click(screen.getByLabelText('Очистить поиск'));
    await waitFor(() => expect(order(container)).toEqual(['Анна', 'Milan', 'Гость']));
    expect(window.location.search).toBe('');
  });

  it('filters written reviews from star-only ones', async () => {
    const { container } = render(<AdminReviewsPage />);
    await screen.findByText('Отлично');
    expect(screen.getByText('С текстом · 1')).toBeTruthy();
    fireEvent.click(screen.getByText('Только звёзды · 2'));
    expect(order(container)).toEqual(['Milan', 'Гость']);
    expect(window.location.search).toBe('?text=without');
  });

  it('summarizes the picked quest as the site shows it', async () => {
    listMock.mockResolvedValue({
      reviews: [...REVIEWS.reviews.slice(0, 2), { ...REVIEWS.reviews[2], hidden: true }],
    });
    render(<AdminReviewsPage />);
    await screen.findByText('Отлично');
    expect(screen.queryByLabelText('Сводка по квесту')).toBeNull();
    fireEvent.change(screen.getByLabelText('Квест'), { target: { value: 'q1' } });
    const summary = screen.getByLabelText('Сводка по квесту');
    // (5 + 4) / 2 over the visible ratings — the hidden 2★ is out of it.
    expect(summary.textContent).toContain('4.5');
    expect(summary.textContent).toContain('2 оценки · 1 скрыто');
  });

  it('renders fifty at a time and starts over when the list changes', async () => {
    const many = Array.from({ length: 120 }, (_, i) => ({
      ...REVIEWS.reviews[0],
      rating: i < 60 ? 5 : 4,
      created_at: 1000 - i,
      identity: id({ user_id: `acct:${i}`, display_name: `Игрок ${i}`, kind: 'email' }),
    }));
    listMock.mockResolvedValue({ reviews: many });
    const { container } = render(<AdminReviewsPage />);
    await screen.findByText('Игрок 0');
    const cards = () => container.querySelectorAll('.amod-card').length;
    expect(cards()).toBe(50);
    fireEvent.click(screen.getByText('Показать ещё · осталось 70'));
    expect(cards()).toBe(100);
    fireEvent.click(screen.getByText('Показать ещё · осталось 20'));
    expect(cards()).toBe(120);
    expect(screen.queryByText(/Показать ещё/)).toBeNull();
    fireEvent.click(screen.getByText('4★ · 60'));
    expect(cards()).toBe(50);
    expect(screen.getByText('Показать ещё · осталось 10')).toBeTruthy();
  });

  it('links account holders to Пользователи and copies any author id', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    render(<AdminReviewsPage />);
    await screen.findByText('Отлично');
    // Анна and Milan have accounts; an anonymous device has no Пользователи entry.
    expect(screen.getAllByText('↗ Пользователи').map((a) => a.getAttribute('href'))).toEqual([
      '/admin?user=acct%3Aanna',
      '/admin?user=acct%3Amilan',
    ]);
    // The raw id is no longer printed — it is one click away.
    expect(screen.queryByText('dev:anon')).toBeNull();
    fireEvent.click(screen.getAllByText('Копировать ID')[2]);
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('dev:anon'));
    expect(await screen.findByText('ID скопирован')).toBeTruthy();
  });

  it('restores filters and sort from the URL', async () => {
    window.history.replaceState(null, '', '/admin/reviews?view=all&rating=2&sort=best');
    const { container } = render(<AdminReviewsPage />);
    await screen.findByText('Гость');
    expect(order(container)).toEqual(['Гость']);
    expect((screen.getByLabelText('Сортировка') as HTMLSelectElement).value).toBe('best');
    expect(screen.getByText('Все · 1').getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByText('2★ · 1').getAttribute('aria-pressed')).toBe('true');
  });

  it('hides a review after a before→after confirm and drops it from view', async () => {
    render(<AdminReviewsPage />);
    await screen.findByText('Отлично');
    // Newest-first ordering → the last «Скрыть» is the oldest, the 2★ anonymous rating.
    fireEvent.click(screen.getAllByText('Скрыть').at(-1)!);
    expect(await screen.findByText('Скрыть отзыв?')).toBeTruthy();
    // Average preview: (5+4+2)/3 = 3.7 → (5+4)/2 = 4.5 after hiding the 2★.
    expect(screen.getByText('3.7')).toBeTruthy();
    expect(screen.getByText('4.5')).toBeTruthy();
    fireEvent.click(screen.getByText('Скрыть отзыв'));
    await waitFor(() =>
      expect(hideMock).toHaveBeenCalledWith({ user_id: 'dev:anon', quest_id: 'q1' }),
    );
    // Hidden (and the «Видимые» view on) → it leaves the list, the hidden counter ticks.
    await waitFor(() => expect(screen.getByText('Скрытые · 1')).toBeTruthy());
    expect(screen.getByText('2 записи')).toBeTruthy();
  });

  it('shows only hidden reviews on their tab and can unhide them', async () => {
    listMock.mockResolvedValue({
      reviews: [REVIEWS.reviews[0], { ...REVIEWS.reviews[2], hidden: true }],
    });
    const { container } = render(<AdminReviewsPage />);
    await screen.findByText('Отлично');
    // The «Видимые» view by default → the hidden one is not shown.
    expect(screen.queryByText('Показать')).toBeNull();
    fireEvent.click(screen.getByText('Скрытые · 1'));
    expect(order(container)).toEqual(['Гость']);
    expect(window.location.search).toBe('?view=hidden');
    fireEvent.click(screen.getByText('Показать'));
    await waitFor(() =>
      expect(unhideMock).toHaveBeenCalledWith({ user_id: 'dev:anon', quest_id: 'q1' }),
    );
  });
});
