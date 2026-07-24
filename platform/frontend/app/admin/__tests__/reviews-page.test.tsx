// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import React from 'react';

/**
 * Admin · Отзывы page. Pinned behaviors: the list renders every rating (star-only
 * included) with the resolved contact; hiding a review confirms with a before→after
 * average preview (same grain the server folds), calls the hide endpoint, and drops
 * the row from the shown list. (Access gating lives in the route layout — see
 * layout.test.tsx; the page itself renders assuming access.)
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
  player_id: 'dev:1',
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
      identity: id({ player_id: 'acct:anna', display_name: 'Анна', kind: 'google', email: 'anna@gmail.com' }),
    },
    {
      quest_id: 'q1',
      quest_name: 'Ирония судьбы',
      quest_city: 'Казань',
      rating: 4,
      text: null,
      created_at: 90,
      hidden: false,
      identity: id({ player_id: 'acct:milan', display_name: 'Milan', kind: 'telegram', telegram_username: 'milan_bg' }),
    },
    {
      quest_id: 'q1',
      quest_name: 'Ирония судьбы',
      quest_city: 'Казань',
      rating: 2,
      text: null,
      created_at: 80,
      hidden: false,
      identity: id({ player_id: 'dev:anon', kind: 'anon' }),
    },
  ],
};

beforeEach(() => {
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
    expect(screen.getByText(/3 записи · 0 скрыто · сначала худшие/)).toBeTruthy();
  });

  it('hides the worst review after a before→after confirm and drops it from view', async () => {
    render(<AdminReviewsPage />);
    await screen.findByText('Отлично');
    // Worst-first ordering → the first «Скрыть» is the 2★ anonymous rating.
    fireEvent.click(screen.getAllByText('Скрыть')[0]);
    expect(await screen.findByText('Скрыть отзыв?')).toBeTruthy();
    // Average preview: (5+4+2)/3 = 3.7 → (5+4)/2 = 4.5 after hiding the 2★.
    expect(screen.getByText('3.7')).toBeTruthy();
    expect(screen.getByText('4.5')).toBeTruthy();
    fireEvent.click(screen.getByText('Скрыть отзыв'));
    await waitFor(() =>
      expect(hideMock).toHaveBeenCalledWith({ player_id: 'dev:anon', quest_id: 'q1' }),
    );
    // Hidden (and showHidden off) → it leaves the list, the hidden counter ticks.
    await waitFor(() => expect(screen.getByText(/1 скрыто/)).toBeTruthy());
  });

  it('reveals hidden reviews via the toggle and can unhide them', async () => {
    listMock.mockResolvedValue({
      reviews: [{ ...REVIEWS.reviews[2], hidden: true }],
    });
    render(<AdminReviewsPage />);
    // Hidden by default → not shown until the toggle is on.
    await waitFor(() => expect(screen.getByText(/1 скрыто/)).toBeTruthy());
    expect(screen.queryByText('Показать')).toBeNull();
    fireEvent.click(screen.getByText(/Показать скрытые/));
    fireEvent.click(await screen.findByText('Показать'));
    await waitFor(() =>
      expect(unhideMock).toHaveBeenCalledWith({ player_id: 'dev:anon', quest_id: 'q1' }),
    );
  });
});
