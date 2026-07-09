// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import React from 'react';

/**
 * SocialAuthButtons (social-auth spec): renders a provider button only when the
 * backend reports it configured, and on the provider callback forwards the signed
 * payload (with the anonymous player_id) to the API, then hands the session back.
 */
const { apiMock } = vi.hoisted(() => ({
  apiMock: {
    getAuthProviders: vi.fn(),
    authTelegram: vi.fn(),
    authGoogle: vi.fn(),
  },
}));
vi.mock('../../../lib/api', () => ({ api: apiMock }));
vi.mock('../../../lib/identity', () => ({ anonymousPlayerId: () => 'dev:anon-1' }));

import SocialAuthButtons from '../SocialAuthButtons';

beforeEach(() => {
  apiMock.getAuthProviders.mockReset();
  apiMock.authTelegram.mockReset();
  apiMock.authGoogle.mockReset();
  delete (window as unknown as { onTelegramAuth?: unknown }).onTelegramAuth;
});

describe('SocialAuthButtons', () => {
  it('renders nothing when no provider is configured', async () => {
    apiMock.getAuthProviders.mockResolvedValue({ google_client_id: null, telegram_bot: null });
    const { container } = render(<SocialAuthButtons onSession={() => {}} dividerLabel="или по почте" />);
    // Wait a microtask for the providers fetch to settle.
    await waitFor(() => expect(apiMock.getAuthProviders).toHaveBeenCalled());
    expect(container.querySelector('.af-social')).toBeNull();
    expect(container.querySelector('.af-divider')).toBeNull();
  });

  it('mounts the Telegram widget and, on its callback, links via the API and returns the session', async () => {
    apiMock.getAuthProviders.mockResolvedValue({ google_client_id: null, telegram_bot: 'geohodbot' });
    const session = { token: 't', player_id: 'dev:anon-1', email: null, display_name: 'Ann', role: 'player' };
    apiMock.authTelegram.mockResolvedValue(session);
    const onSession = vi.fn();

    const { container } = render(<SocialAuthButtons onSession={onSession} />);
    // The Telegram slot mounts and installs the global the widget will call.
    await waitFor(() => expect(container.querySelector('.social-btn--telegram')).not.toBeNull());
    await waitFor(() =>
      expect((window as unknown as { onTelegramAuth?: unknown }).onTelegramAuth).toBeTypeOf('function'),
    );

    // Simulate the Telegram Login Widget invoking data-onauth with a signed user.
    const user = { id: 55, first_name: 'Ann', auth_date: 1_700_000_000, hash: 'abcd' };
    (window as unknown as { onTelegramAuth: (u: unknown) => void }).onTelegramAuth(user);

    await waitFor(() => expect(apiMock.authTelegram).toHaveBeenCalledWith({ ...user, player_id: 'dev:anon-1' }));
    await waitFor(() => expect(onSession).toHaveBeenCalledWith(session));
  });

  it('shows the divider only when a button renders', async () => {
    apiMock.getAuthProviders.mockResolvedValue({ google_client_id: null, telegram_bot: 'geohodbot' });
    render(<SocialAuthButtons onSession={() => {}} dividerLabel="или по почте" />);
    await waitFor(() => expect(screen.getByText('или по почте')).toBeTruthy());
  });
});
