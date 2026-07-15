// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import React from 'react';

/**
 * Admin · Features page. Pinned behaviors:
 * - rows render from GET /api/admin/features with Russian labels and the
 *   state line (default vs override);
 * - the switch POSTs the flipped effective value and the row re-renders from
 *   the returned wire object;
 * - «сбросить» appears only while an override is stored and POSTs
 *   `enabled: null`;
 * - an unconfigured-but-on flag shows the inert-switch warning;
 * - a failed load shows the reload hint instead of rows.
 */
const { listMock, setMock, meMock } = vi.hoisted(() => ({
  listMock: vi.fn(),
  setMock: vi.fn(),
  meMock: vi.fn(),
}));
vi.mock('../../../lib/api', () => ({
  api: { adminListFeatures: listMock, adminSetFeature: setMock, me: meMock },
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

import AdminFeaturesPage from '../features/page';

const ROW = {
  key: 'payments_mock',
  default_enabled: true,
  override: null as boolean | null,
  effective: true,
  available: true,
};

beforeEach(() => {
  listMock.mockReset();
  setMock.mockReset();
  meMock.mockReset();
  meMock.mockResolvedValue({ role: 'admin' });
  listMock.mockResolvedValue([ROW]);
});

describe('AdminFeaturesPage', () => {
  it('renders a labeled row with the default state and no reset affordance', async () => {
    render(<AdminFeaturesPage />);
    expect(await screen.findByText('Тестовая оплата')).toBeTruthy();
    expect(screen.getByText('по умолчанию · вкл')).toBeTruthy();
    expect(screen.queryByText('сбросить')).toBeNull();
    const sw = screen.getByRole('switch');
    expect(sw.getAttribute('aria-checked')).toBe('true');
  });

  it('flips the flag via the switch and re-renders from the returned wire', async () => {
    setMock.mockResolvedValue({ ...ROW, override: false, effective: false });
    render(<AdminFeaturesPage />);
    fireEvent.click(await screen.findByRole('switch'));
    await waitFor(() => expect(setMock).toHaveBeenCalledWith('payments_mock', false));
    expect(await screen.findByText('переопределено · выкл')).toBeTruthy();
    expect(screen.getByRole('switch').getAttribute('aria-checked')).toBe('false');
    expect(screen.getByText('сбросить')).toBeTruthy();
  });

  it('clears the override with «сбросить» (enabled: null)', async () => {
    listMock.mockResolvedValue([{ ...ROW, override: false, effective: false }]);
    setMock.mockResolvedValue(ROW);
    render(<AdminFeaturesPage />);
    fireEvent.click(await screen.findByText('сбросить'));
    await waitFor(() => expect(setMock).toHaveBeenCalledWith('payments_mock', null));
    expect(await screen.findByText('по умолчанию · вкл')).toBeTruthy();
  });

  it('warns when a switched-on flag is unconfigured on this deployment', async () => {
    listMock.mockResolvedValue([
      { key: 'auth_google', default_enabled: true, override: null, effective: true, available: false },
    ]);
    render(<AdminFeaturesPage />);
    expect(await screen.findByText(/Не настроено на этом сервере/)).toBeTruthy();
  });

  it('shows the reload hint when the list fails to load', async () => {
    listMock.mockRejectedValue(new Error('down'));
    render(<AdminFeaturesPage />);
    expect(await screen.findByText(/Не удалось загрузить список функций/)).toBeTruthy();
  });
});
