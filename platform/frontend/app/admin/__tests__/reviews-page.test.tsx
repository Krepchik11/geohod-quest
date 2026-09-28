// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import React from 'react';

/**
 * Admin · Отзывы page. Pinned behaviors: the list renders every rating (star-only
 * included) with the resolved contact, newest first unless another sort is picked;
 * every filter option carries its count; filters and sort round-trip through the
 * URL; hiding a review confirms with a before→after average preview (same grain the
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
