// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import React from 'react';

/**
 * SiteHeader «админка» counter: an admin sees what waits for a moderator (new
 * reviews + open feedback) — red when a new low rating is among them; anyone
 * else never triggers the admin read.
 */
const { meMock, countsMock } = vi.hoisted(() => ({ meMock: vi.fn(), countsMock: vi.fn() }));
vi.mock('../../lib/use-me', () => ({ useMe: meMock }));
vi.mock('../../lib/api', () => ({
  api: { adminModerationCounts: countsMock },
  hasAdminToken: () => false,
}));
vi.mock('../components/UserMenu', () => ({ default: () => null }));

import SiteHeader from '../SiteHeader';

beforeEach(() => {
  countsMock.mockReset();
  countsMock.mockResolvedValue({ reviews_new: 3, reviews_new_low: 1, feedback_open: 2 });
});

describe('SiteHeader «админка» counter', () => {
  it('counts new reviews and open feedback for an admin', async () => {
    meMock.mockReturnValue({ role: 'admin', session: { token: 't' }, displayName: null });
    render(<SiteHeader />);
    const link = await screen.findByRole('link', { name: /^Админка\s*, ждут проверки: 5$/ });
    expect(link.querySelector('.nav-badge.is-alert')).toBeTruthy();
  });

  it('never asks for the counters for a player', async () => {
    meMock.mockReturnValue({ role: 'player', session: { token: 't' }, displayName: null });
    render(<SiteHeader />);
    await waitFor(() => expect(screen.queryByText('Админка')).toBeNull());
    expect(countsMock).not.toHaveBeenCalled();
  });
});
