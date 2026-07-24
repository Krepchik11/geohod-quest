import { vi } from 'vitest';

/**
 * Module mocks for tests that render chrome containing UserMenu/SiteHeader
 * (they import lib/api, lib/identity and lib/session-actions transitively):
 * an anonymous viewer with no admin token. One copy, shared via
 *   vi.mock('../../../lib/api', async () => (await import('./chrome-mocks')).apiMock);
 */
export const apiMock = {
  api: { me: vi.fn(async () => ({ role: 'player', display_name: null })) },
  ApiError: class extends Error {
    status = 0;
  },
  hasAdminToken: () => false,
};

export const identityMock = {
  getSession: () => null,
  subscribeSession: () => () => {},
  clearSession: vi.fn(),
};

export const sessionActionsMock = { logoutAndReset: vi.fn(async () => {}) };
