// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import React from 'react';

/**
 * app/admin/layout.tsx — the ONE mount of the admin chrome. Pinned behaviors:
 * - the shell header + access gate live in the route layout, so navigating
 *   between admin tabs never remounts the header or re-runs the access check
 *   (the per-navigation flash/shift this replaces);
 * - the active tab derives from the router's child segment, including nested
 *   routes (segment 'coupons' covers /admin/coupons/new);
 * - the /me role comes from the shared lib/use-me cache (one request for the
 *   gate and the header's UserMenu together), and anonymous visitors are
 *   denied without any request;
 * - children render only when access is granted; the denied/error screens
 *   render inside the shell so the chrome stays put.
 */
const { meMock, tokenMock, sessionMock, segmentMock } = vi.hoisted(() => ({
  meMock: vi.fn(),
  tokenMock: vi.fn(),
  sessionMock: vi.fn(),
  segmentMock: vi.fn(),
}));
vi.mock('../../../lib/api', () => ({
  api: { me: meMock },
  ApiError: class ApiError extends Error {
    status: number;
    constructor(status: number, _path?: string, message?: string) {
      super(message ?? `api ${status}`);
      this.status = status;
    }
  },
  hasAdminToken: tokenMock,
}));
vi.mock('../../../lib/identity', () => ({
  getSession: sessionMock,
  subscribeSession: () => () => {},
}));
vi.mock('../../../lib/session-actions', () => ({
  logoutAndReset: () => Promise.resolve(),
}));
vi.mock('next/navigation', () => ({
  useSelectedLayoutSegment: segmentMock,
}));

import AdminLayout from '../layout';
import { ApiError } from '../../../lib/api';

// The /me cache in lib/use-me is module-level and token-keyed; a fresh token
// per test keeps the cases independent.
let tokenSeq = 0;
function session(): { token: string; role: string; display_name: null } {
  tokenSeq += 1;
  return { token: `t${tokenSeq}`, role: 'player', display_name: null };
}

beforeEach(() => {
  meMock.mockReset();
  tokenMock.mockReset();
  sessionMock.mockReset();
  segmentMock.mockReset();
  segmentMock.mockReturnValue(null);
  tokenMock.mockReturnValue(false);
  sessionMock.mockReturnValue(session());
  meMock.mockResolvedValue({ role: 'admin', display_name: null });
});

describe('AdminLayout', () => {
  it('renders the shell chrome and the page once access is granted', async () => {
    render(
      <AdminLayout>
        <div>page-body</div>
      </AdminLayout>,
    );
    expect(await screen.findByText('page-body')).toBeTruthy();
    // Chrome present: tab strip with the users tab active for /admin.
    const users = screen
      .getAllByRole('link', { name: 'Пользователи' })
      .find((a) => a.getAttribute('aria-current') === 'page');
    expect(users).toBeTruthy();
    // Gate and header share the cached /me — one request total.
    expect(meMock).toHaveBeenCalledTimes(1);
  });

  it('highlights the section tab for nested routes (segment coupons → Купоны)', async () => {
    segmentMock.mockReturnValue('coupons');
    render(
      <AdminLayout>
        <div>page-body</div>
      </AdminLayout>,
    );
    await screen.findByText('page-body');
    const active = screen
      .getAllByRole('link', { name: 'Купоны' })
      .find((a) => a.getAttribute('aria-current') === 'page');
    expect(active).toBeTruthy();
    expect(
      screen
        .getAllByRole('link', { name: 'Пользователи' })
        .some((a) => a.getAttribute('aria-current') === 'page'),
    ).toBe(false);
  });

  it('shows the spinner while checking and no page body', () => {
    meMock.mockReturnValue(new Promise(() => {}));
    render(
      <AdminLayout>
        <div>page-body</div>
      </AdminLayout>,
    );
    expect(screen.getByLabelText('Загрузка')).toBeTruthy();
    expect(screen.queryByText('page-body')).toBeNull();
  });

  it('denies a signed-in non-admin — children never render', async () => {
    meMock.mockResolvedValue({ role: 'player', display_name: null });
    render(
      <AdminLayout>
        <div>page-body</div>
      </AdminLayout>,
    );
    expect(await screen.findByText('Нет доступа')).toBeTruthy();
    expect(screen.queryByText('page-body')).toBeNull();
  });

  it('denies an expired session (401/403 from /me)', async () => {
    meMock.mockRejectedValue(new ApiError(403, '/api/players/me', 'forbidden'));
    render(
      <AdminLayout>
        <div>page-body</div>
      </AdminLayout>,
    );
    expect(await screen.findByText('Нет доступа')).toBeTruthy();
  });

  it('denies anonymous visitors without any network request', () => {
    sessionMock.mockReturnValue(null);
    render(
      <AdminLayout>
        <div>page-body</div>
      </AdminLayout>,
    );
    expect(screen.getByText('Нет доступа')).toBeTruthy();
    expect(meMock).not.toHaveBeenCalled();
  });

  it('grants the operator token without a session', () => {
    sessionMock.mockReturnValue(null);
    tokenMock.mockReturnValue(true);
    render(
      <AdminLayout>
        <div>page-body</div>
      </AdminLayout>,
    );
    expect(screen.getByText('page-body')).toBeTruthy();
  });

  it('shows the server-unavailable screen on a network failure', async () => {
    meMock.mockRejectedValue(new Error('offline'));
    render(
      <AdminLayout>
        <div>page-body</div>
      </AdminLayout>,
    );
    expect(await screen.findByText('Сервер недоступен')).toBeTruthy();
  });
});
