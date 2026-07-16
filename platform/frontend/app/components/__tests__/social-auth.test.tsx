// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import React from 'react';

/**
 * SocialAuthButtons (social-auth spec): renders a provider button only when the
 * backend reports it configured, and on the provider callback forwards the OIDC
 * id_token (with the anonymous player_id) to the API, then hands the session back.
 */
const { apiMock } = vi.hoisted(() => ({
  apiMock: {
    getAuthProviders: vi.fn(),
    authTelegram: vi.fn(),
    authGoogle: vi.fn(),
  },
}));
vi.mock('../../../lib/api', () => ({
  api: apiMock,
  // Real helper shape: server message when present, fallback otherwise.
  apiErrorMessage: (_err: unknown, fallback: string) => fallback,
}));
vi.mock('../../../lib/identity', () => ({ anonymousPlayerId: () => 'dev:anon-1' }));

import SocialAuthButtons from '../SocialAuthButtons';

/** Resolve the `telegram-login.js` <script> loadScript injects by firing its load
 *  event, after installing the `Telegram.Login` global the popup flow needs. */
function readyTelegram(auth: (opts: unknown, cb: (r: { id_token?: string }) => void) => void) {
  (window as unknown as { Telegram?: unknown }).Telegram = { Login: { auth } };
  const script = document.querySelector<HTMLScriptElement>('script[src*="telegram-login.js"]');
  script?.dispatchEvent(new Event('load'));
}

beforeEach(() => {
  apiMock.getAuthProviders.mockReset();
  apiMock.authTelegram.mockReset();
  apiMock.authGoogle.mockReset();
  delete (window as unknown as { Telegram?: unknown }).Telegram;
  document.head.querySelectorAll('script[src*="telegram-login.js"]').forEach((s) => s.remove());
});

describe('SocialAuthButtons', () => {
  it('renders nothing when no provider is configured', async () => {
    apiMock.getAuthProviders.mockResolvedValue({ google_client_id: null, telegram_client_id: null });
    const { container } = render(<SocialAuthButtons onSession={() => {}} dividerLabel="или по почте" />);
    // Wait a microtask for the providers fetch to settle.
    await waitFor(() => expect(apiMock.getAuthProviders).toHaveBeenCalled());
    expect(container.querySelector('.af-social')).toBeNull();
    expect(container.querySelector('.af-divider')).toBeNull();
  });

  it('opens the Telegram OIDC popup and forwards the id_token, returning the session', async () => {
    apiMock.getAuthProviders.mockResolvedValue({ google_client_id: null, telegram_client_id: '424242' });
    const session = { token: 't', player_id: 'dev:anon-1', email: null, display_name: 'Ann', role: 'player' };
    apiMock.authTelegram.mockResolvedValue(session);
    const onSession = vi.fn();

    const { container } = render(<SocialAuthButtons onSession={onSession} />);
    const button = await waitFor(() => {
      const b = container.querySelector<HTMLButtonElement>('.social-btn--telegram');
      if (!b) throw new Error('telegram button not mounted');
      return b;
    });

    // Library loads → button enables. The popup callback yields the OIDC id_token.
    const auth = vi.fn((_opts, cb: (r: { id_token?: string }) => void) => cb({ id_token: 'JWT' }));
    readyTelegram(auth);
    await waitFor(() => expect(button.disabled).toBe(false));

    fireEvent.click(button);
    // The bot's numeric client id is passed to Telegram.Login.auth.
    expect(auth).toHaveBeenCalledWith(
      expect.objectContaining({ client_id: 424242 }),
      expect.any(Function),
    );
    await waitFor(() =>
      expect(apiMock.authTelegram).toHaveBeenCalledWith({ id_token: 'JWT', player_id: 'dev:anon-1' }),
    );
    await waitFor(() => expect(onSession).toHaveBeenCalledWith(session));
  });

  it('shows the divider only when a button renders', async () => {
    apiMock.getAuthProviders.mockResolvedValue({ google_client_id: null, telegram_client_id: '424242' });
    render(<SocialAuthButtons onSession={() => {}} dividerLabel="или по почте" />);
    await waitFor(() => expect(screen.getByText('или по почте')).toBeTruthy());
  });

  it('on failure delegates to onError WITHOUT also rendering its own inline error', async () => {
    // Regression: the message must not appear twice (parent renders via onError).
    apiMock.getAuthProviders.mockResolvedValue({ google_client_id: null, telegram_client_id: '424242' });
    apiMock.authTelegram.mockRejectedValue(new Error('boom'));
    const onError = vi.fn();

    const { container } = render(<SocialAuthButtons onSession={() => {}} onError={onError} />);
    const button = await waitFor(() => {
      const b = container.querySelector<HTMLButtonElement>('.social-btn--telegram');
      if (!b) throw new Error('telegram button not mounted');
      return b;
    });
    readyTelegram((_opts, cb) => cb({ id_token: 'JWT' }));
    await waitFor(() => expect(button.disabled).toBe(false));

    fireEvent.click(button);
    await waitFor(() => expect(onError).toHaveBeenCalledTimes(1));
    // No internal inline copy when a parent handler is present.
    expect(container.querySelector('.af-social__error')).toBeNull();
  });
});
