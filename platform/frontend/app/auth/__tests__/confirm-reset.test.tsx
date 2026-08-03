// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import React from 'react';

/**
 * §6.2/§6.3 mailed-link landing pages: /auth/confirm?token=… (soft email
 * confirmation) and /auth/reset?token=… (password reset that signs in).
 */
const { apiMock, sessionRef, setSessionMock, searchRef, routerMock } = vi.hoisted(() => ({
  apiMock: {
    me: vi.fn(async () => ({ role: 'player' })),
    authConfirmEmail: vi.fn(),
    authResetPassword: vi.fn(),
  },
  sessionRef: { current: null as unknown },
  setSessionMock: vi.fn(),
  searchRef: { current: new URLSearchParams() },
  routerMock: { push: vi.fn() },
}));
vi.mock('../../../lib/api', () => ({ api: apiMock, ApiError: class extends Error { status = 0; }, hasAdminToken: () => false }));
vi.mock('../../../lib/identity', () => ({
  anonymousUserId: () => 'dev:test',
  getSession: () => sessionRef.current,
  setSession: setSessionMock,
  clearSession: vi.fn(),
  subscribeSession: () => () => {},
}));
vi.mock('../../../lib/session-actions', () => ({ logoutAndReset: vi.fn(async () => {}) }));
vi.mock('next/navigation', () => ({
  useSearchParams: () => searchRef.current,
  useRouter: () => routerMock,
}));

import ConfirmPage from '../confirm/page';
import ResetPage from '../reset/page';

beforeEach(() => {
  apiMock.authConfirmEmail.mockReset();
  apiMock.authResetPassword.mockReset();
  setSessionMock.mockReset();
  routerMock.push.mockReset();
  searchRef.current = new URLSearchParams();
  sessionRef.current = null;
});

describe('ConfirmPage — /auth/confirm (§6.3)', () => {
  it('valid token → consumed once → «Почта подтверждена» with the email', async () => {
    searchRef.current = new URLSearchParams('token=tok-1');
    apiMock.authConfirmEmail.mockResolvedValue({ status: 'confirmed', email: 'anna@gmail.com' });
    render(<ConfirmPage />);
    await waitFor(() => expect(screen.getByText('Почта подтверждена')).toBeTruthy());
    expect(apiMock.authConfirmEmail).toHaveBeenCalledExactlyOnceWith('tok-1');
    expect(screen.getByText(/anna@gmail.com/)).toBeTruthy();
  });

  it('stale/used token (400) → «Ссылка не сработала» with the resend hint', async () => {
    searchRef.current = new URLSearchParams('token=stale');
    apiMock.authConfirmEmail.mockRejectedValue(Object.assign(new Error('400'), { status: 400 }));
    render(<ConfirmPage />);
    await waitFor(() => expect(screen.getByText('Ссылка не сработала')).toBeTruthy());
    expect(screen.getByText(/Запросите новое письмо из профиля/)).toBeTruthy();
  });

  it('missing token → error state without any API call', () => {
    render(<ConfirmPage />);
    expect(screen.getByText('Ссылка не сработала')).toBeTruthy();
    expect(apiMock.authConfirmEmail).not.toHaveBeenCalled();
  });
});

describe('ResetPage — /auth/reset (§6.2)', () => {
  it('missing token → explains and links back to /auth, no form', () => {
    render(<ResetPage />);
    expect(screen.getByText(/В ссылке нет кода восстановления/)).toBeTruthy();
    expect(screen.queryByLabelText('Придумайте пароль')).toBeNull();
  });

  it('short password is refused locally — no API call', () => {
    searchRef.current = new URLSearchParams('token=tok-r');
    render(<ResetPage />);
    fireEvent.change(screen.getByLabelText('Придумайте пароль'), { target: { value: 'short' } });
    fireEvent.click(screen.getByRole('button', { name: 'Сменить пароль и войти' }));
    expect(screen.getByText('Минимум 8 символов', { selector: '.af-error' })).toBeTruthy();
    expect(apiMock.authResetPassword).not.toHaveBeenCalled();
  });

  it('success → resets with the mailed token, stores the session, goes to /profile', async () => {
    searchRef.current = new URLSearchParams('token=tok-r');
    const session = { token: 't', user_id: 'dev:test', email: 'anna@gmail.com', display_name: null, role: 'player' };
    apiMock.authResetPassword.mockResolvedValue(session);
    render(<ResetPage />);
    fireEvent.change(screen.getByLabelText('Придумайте пароль'), { target: { value: 'password-123' } });
    fireEvent.click(screen.getByRole('button', { name: 'Сменить пароль и войти' }));
    await waitFor(() =>
      expect(apiMock.authResetPassword).toHaveBeenCalledExactlyOnceWith({ token: 'tok-r', password: 'password-123' }),
    );
    expect(setSessionMock).toHaveBeenCalledExactlyOnceWith(session);
    expect(routerMock.push).toHaveBeenCalledExactlyOnceWith('/profile');
  });

  it('stale/used token (400) → explains and points to requesting a new link', async () => {
    searchRef.current = new URLSearchParams('token=stale');
    apiMock.authResetPassword.mockRejectedValue(Object.assign(new Error('400'), { status: 400 }));
    render(<ResetPage />);
    fireEvent.change(screen.getByLabelText('Придумайте пароль'), { target: { value: 'password-123' } });
    fireEvent.click(screen.getByRole('button', { name: 'Сменить пароль и войти' }));
    await waitFor(() => expect(screen.getByText(/Ссылка недействительна или устарела/)).toBeTruthy());
    expect(setSessionMock).not.toHaveBeenCalled();
    expect(routerMock.push).not.toHaveBeenCalled();
  });
});
