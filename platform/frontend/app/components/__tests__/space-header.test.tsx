// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import React from 'react';

/**
 * SpaceHeader — ONE top bar (logo lockup + space eyebrow + optional tabs +
 * user menu) shared by the admin and constructor spaces, so both wear the
 * same chrome instead of three bespoke headers.
 */
vi.mock('../../../lib/api', () => ({
  api: { me: vi.fn(async () => ({ role: 'admin', display_name: null })) },
  ApiError: class extends Error { status = 0; },
  hasAdminToken: () => false,
}));
vi.mock('../../../lib/identity', () => ({
  getSession: () => null,
  subscribeSession: () => () => {},
  clearSession: vi.fn(),
}));
vi.mock('../../../lib/session-actions', () => ({ logoutAndReset: vi.fn(async () => {}) }));

import SpaceHeader from '../SpaceHeader';

const TABS = [
  { key: 'users', label: 'Пользователи', href: '/admin' },
  { key: 'coupons', label: 'Купоны', href: '/admin/coupons' },
];

describe('SpaceHeader', () => {
  it('renders the logo home link and the space eyebrow', () => {
    render(<SpaceHeader eyebrow="АДМИНКА" />);
    const home = screen.getByLabelText('GEOHOD QUEST — на главную');
    expect(home.getAttribute('href')).toBe('/');
    expect(screen.getAllByText('АДМИНКА').length).toBeGreaterThan(0);
  });

  it('marks exactly the active tab with aria-current in both tab strips', () => {
    render(<SpaceHeader eyebrow="АДМИНКА" tabs={TABS} active="coupons" />);
    // Desktop inline strip + mobile row render the same tabs.
    const current = screen.getAllByRole('link', { current: 'page' });
    expect(current.length).toBe(2);
    for (const link of current) expect(link.textContent).toBe('Купоны');
    expect(screen.getAllByText('Пользователи').length).toBe(2);
  });

  it('renders no tab strip when the space has no tabs', () => {
    render(<SpaceHeader eyebrow="КОНСТРУКТОР" />);
    expect(screen.queryByRole('navigation')).toBeNull();
  });
});
