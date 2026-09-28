// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import React from 'react';

/**
 * Admin · Пользователи — the jump from Отзывы (`/admin?user=<id>`): the profile
 * opens with the list narrowed to it and the parameter is dropped, so a reload
 * starts clean; an id that is not in the list says so instead of opening nothing.
 */
const { listMock } = vi.hoisted(() => ({ listMock: vi.fn() }));
vi.mock('../../../lib/api', () => ({
  api: { adminListUsers: listMock, adminSetUserRole: vi.fn() },
  classify: vi.fn(),
  isAuthFailure: () => false,
}));

import AdminUsersPage from '../page';

const USERS = [
  { user_id: 'acct:anna', email: 'anna@gmail.com', display_name: 'Анна', role: 'player', created_at: 100 },
  { user_id: 'acct:boris', email: 'boris@mail.ru', display_name: null, role: 'editor', created_at: 90 },
];

beforeEach(() => {
  listMock.mockReset();
  listMock.mockResolvedValue(USERS);
});

describe('AdminUsersPage deep link', () => {
  it('opens the linked profile with the list narrowed to it', async () => {
    window.history.replaceState(null, '', '/admin?user=acct%3Aboris');
    const { container } = render(<AdminUsersPage />);
    await waitFor(() =>
      expect(container.querySelector('.au-identity-title')?.textContent).toBe('boris@mail.ru'),
    );
    expect((screen.getByLabelText('Поиск пользователей') as HTMLInputElement).value).toBe(
      'boris@mail.ru',
    );
    expect(screen.queryByText('Анна')).toBeNull();
    expect(window.location.search).toBe('');
  });

  it('says so when the linked user is not in the list', async () => {
    window.history.replaceState(null, '', '/admin?user=acct%3Aghost');
    const { container } = render(<AdminUsersPage />);
    expect(await screen.findByText('Пользователь не найден')).toBeTruthy();
    expect(container.querySelector('.au-identity-title')).toBeNull();
    expect(window.location.search).toBe('');
  });
});
