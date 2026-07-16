// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import React from 'react';

/**
 * Admin · Статистика page. Pinned behaviors:
 * - the overview renders KPI values, the period line and the per-quest rows
 *   from GET /api/admin/stats;
 * - «Всё время» hides deltas (prev=null) and re-queries without `from`;
 * - clicking a quest row loads GET /api/admin/stats/{id} and shows the funnel
 *   with the worst-drop badge; «ко всем квестам» returns to the overview;
 * - a failed load shows the reload hint.
 */
const { overviewMock, questMock, meMock } = vi.hoisted(() => ({
  overviewMock: vi.fn(),
  questMock: vi.fn(),
  meMock: vi.fn(),
}));
vi.mock('../../../lib/api', () => ({
  api: { adminStatsOverview: overviewMock, adminStatsQuest: questMock, me: meMock },
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

import AdminStatsPage from '../stats/page';

const OVERVIEW = {
  from: '2026-06-17',
  to: '2026-07-16',
  totals: { purchased: 120, started: 100, finished: 55 },
  prev: { purchased: 100, started: 80, finished: 50 },
  daily: [
    { date: '2026-07-15', started: 4, finished: 1 },
    { date: '2026-07-16', started: 6, finished: 3 },
  ],
  quests: [
    {
      quest_id: 'q1',
      name: 'Тайны старого города',
      city: 'Казань',
      template_summary: '7 steps',
      pages: 7,
      published: true,
      purchased: 80,
      started: 60,
      finished: 20,
    },
  ],
};

const DETAIL = {
  quest_id: 'q1',
  name: 'Тайны старого города',
  city: 'Казань',
  template_summary: '7 steps',
  pages: 7,
  from: '2026-06-17',
  to: '2026-07-16',
  totals: { purchased: 80, started: 60, finished: 20 },
  prev: { purchased: 70, started: 50, finished: 25 },
  snapshot_id: 'q1-v1',
  snapshot_version: 1,
  funnel_started: 60,
  funnel: [
    { position: 0, title: 'Старт: у башни', template: 'start', reached: 60 },
    { position: 1, title: 'Задание: герб', template: 'task_answer', reached: 30 },
    { position: 2, title: 'Финал', template: 'congrats', reached: 28 },
  ],
};

beforeEach(() => {
  overviewMock.mockReset();
  questMock.mockReset();
  meMock.mockReset();
  meMock.mockResolvedValue({ role: 'admin' });
  overviewMock.mockResolvedValue(OVERVIEW);
  questMock.mockResolvedValue(DETAIL);
});

describe('AdminStatsPage', () => {
  it('renders KPI cards, the period line and quest rows from the API', async () => {
    render(<AdminStatsPage />);
    expect(await screen.findByText('Куплено квестов')).toBeTruthy();
    expect(screen.getByText('120')).toBeTruthy();
    // Completion 55/100 with a −7.5 п.п. delta against the previous window.
    expect(screen.getByText('55.0%')).toBeTruthy();
    expect(screen.getByText('−7.5 п.п.')).toBeTruthy();
    expect(screen.getByText('17 июн — 16 июл 2026 · 30 дн.')).toBeTruthy();
    expect(screen.getByText('Тайны старого города')).toBeTruthy();
    expect(screen.getByText('Казань · 7 шагов')).toBeTruthy();
    expect(screen.getByText('20 из 60')).toBeTruthy();
    // Default chip: 30 дней, requesting an inclusive bounded range.
    expect(overviewMock).toHaveBeenCalledWith(
      expect.objectContaining({ from: expect.any(String), to: expect.any(String) }),
    );
  });

  it('«Всё время» re-queries without from and hides deltas', async () => {
    render(<AdminStatsPage />);
    await screen.findByText('Куплено квестов');
    overviewMock.mockResolvedValue({ ...OVERVIEW, prev: null });
    fireEvent.click(screen.getByText('Всё время'));
    await waitFor(() => {
      const last = overviewMock.mock.calls.at(-1)![0];
      expect(last.from).toBeUndefined();
      expect(last.to).toBeTruthy();
    });
    await waitFor(() => expect(screen.queryByText(/к пред\. периоду/)).toBeNull());
  });

  it('opens the funnel drill-down and returns via «ко всем квестам»', async () => {
    render(<AdminStatsPage />);
    fireEvent.click(await screen.findByText('Тайны старого города'));
    expect(await screen.findByText('Воронка шагов')).toBeTruthy();
    expect(questMock).toHaveBeenCalledWith('q1', expect.any(Object));
    expect(screen.getByText('Старт: у башни')).toBeTruthy();
    // 30/60 = the worst drop (−50%) gets the badge; final reach = 47%.
    expect(screen.getByText('наибольший отток')).toBeTruthy();
    expect(screen.getByText(/−50% · ушли 30 чел\./)).toBeTruthy();
    expect(screen.getByText(/До финала доходит 47%/)).toBeTruthy();
    fireEvent.click(screen.getByText(/ко всем квестам/));
    expect(await screen.findByText('Куплено квестов')).toBeTruthy();
  });

  it('shows the reload hint when the overview fails to load', async () => {
    overviewMock.mockRejectedValue(new Error('down'));
    render(<AdminStatsPage />);
    expect(await screen.findByText(/Не удалось загрузить статистику/)).toBeTruthy();
  });
});
