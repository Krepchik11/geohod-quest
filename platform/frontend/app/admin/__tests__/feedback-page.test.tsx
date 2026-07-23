// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import React from 'react';

/**
 * Admin · Обратная связь page. Pinned behaviors: current-version groups render with
 * their step label, status, and reports (contacts per kind); marking a group resolved
 * calls the resolve endpoint and removes it from the «Открытые» view; the status
 * filter and the past-versions archive work.
 */
const { listMock, resolveMock, reopenMock, meMock } = vi.hoisted(() => ({
  listMock: vi.fn(),
  resolveMock: vi.fn(),
  reopenMock: vi.fn(),
  meMock: vi.fn(),
}));
vi.mock('../../../lib/api', () => ({
  api: {
    adminListFeedback: listMock,
    adminResolveFeedback: resolveMock,
    adminReopenFeedback: reopenMock,
    me: meMock,
  },
  ApiError: class ApiError extends Error {
    status: number;
    constructor(status: number) {
      super(`api ${status}`);
      this.status = status;
    }
  },
  hasAdminToken: () => true,
}));
vi.mock('../../../lib/identity', () => ({
  getSession: () => null,
  subscribeSession: () => () => {},
}));
vi.mock('../../../lib/session-actions', () => ({
  logoutAndReset: () => Promise.resolve(),
}));

import AdminFeedbackPage from '../feedback/page';
import type { AdminIdentityWire } from '../../../lib/api';

const id = (over: Partial<AdminIdentityWire>): AdminIdentityWire => ({
  player_id: 'dev:1',
  display_name: null,
  kind: 'anon',
  email: null,
  telegram_username: null,
  ...over,
});

const GROUPS = {
  groups: [
    {
      quest_id: 'q1',
      quest_name: 'Ирония судьбы',
      quest_city: 'Казань',
      snapshot_id: 'q1-v4',
      version: 4,
      step_position: 4,
      step_title: 'Фонтан у театра',
      step_template: 'task_answer',
      current: true,
      resolved: false,
      reports: [
        { note: 'Ответ не принят', recorded_at: 100, identity: id({ player_id: 'acct:igor', display_name: 'Игорь', kind: 'email', email: 'igor@mail.ru' }) },
        { note: 'not accepted', recorded_at: 90, identity: id({ player_id: 'acct:milan', display_name: 'Milan', kind: 'telegram', telegram_username: 'milan_bg' }) },
      ],
    },
    {
      quest_id: 'q1',
      quest_name: 'Ирония судьбы',
      quest_city: 'Казань',
      snapshot_id: 'q1-v3',
      version: 3,
      step_position: 4,
      step_title: 'Фонтан (версия 3)',
      step_template: 'task_answer',
      current: false,
      resolved: true,
      reports: [{ note: 'старое', recorded_at: 10, identity: id({ kind: 'anon' }) }],
    },
  ],
};

beforeEach(() => {
  listMock.mockReset();
  resolveMock.mockReset();
  reopenMock.mockReset();
  meMock.mockReset();
  meMock.mockResolvedValue({ role: 'admin' });
  listMock.mockResolvedValue(GROUPS);
  resolveMock.mockResolvedValue({});
  reopenMock.mockResolvedValue({});
});

describe('AdminFeedbackPage', () => {
  it('renders the current open group and its reports with contacts', async () => {
    render(<AdminFeedbackPage />);
    expect(await screen.findByText('Шаг 4 · Фонтан у театра')).toBeTruthy();
    expect(screen.getByText('Открытых: 1 · Решённых: 0')).toBeTruthy();
    expect(screen.getByText('ОТКРЫТО')).toBeTruthy();
    // The resolved past-version group is hidden under the default «Открытые» filter.
    expect(screen.queryByText('Фонтан (версия 3)')).toBeNull();

    fireEvent.click(screen.getByText('Шаг 4 · Фонтан у театра'));
    expect(await screen.findByText('Ответ не принят')).toBeTruthy();
    expect(screen.getByText('@milan_bg')).toBeTruthy();
    expect(screen.getByText('igor@mail.ru')).toBeTruthy();
  });

  it('resolves a group and drops it from the «Открытые» view', async () => {
    render(<AdminFeedbackPage />);
    fireEvent.click(await screen.findByText('Шаг 4 · Фонтан у театра'));
    fireEvent.click(await screen.findByText('Отметить решённым'));
    await waitFor(() =>
      expect(resolveMock).toHaveBeenCalledWith({
        quest_id: 'q1',
        snapshot_id: 'q1-v4',
        step_position: 4,
      }),
    );
    await waitFor(() => expect(screen.getByText('Открытых: 0 · Решённых: 1')).toBeTruthy());
    // Now resolved → gone from the open-only list.
    expect(screen.getByText('Нет обращений по выбранному фильтру.')).toBeTruthy();
  });

  it('shows the past-versions archive under «Все»', async () => {
    render(<AdminFeedbackPage />);
    await screen.findByText('Шаг 4 · Фонтан у театра');
    fireEvent.click(screen.getByText('Все'));
    expect(await screen.findByText(/Архив прошлых версий · 1/)).toBeTruthy();
    fireEvent.click(screen.getByText(/Архив прошлых версий · 1/));
    expect(await screen.findByText('Шаг 4 · Фонтан (версия 3)')).toBeTruthy();
  });
});
