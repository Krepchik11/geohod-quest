// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import React from 'react';

/**
 * §6.2 R2 — reset by emailed 6-digit code, typed on the «Письмо ушло» card so
 * mobile users read the code off the mail notification and never leave the
 * app (the R1 link keeps working in parallel).
 */
const { apiMock, sessionRef, setSessionMock } = vi.hoisted(() => ({
  apiMock: {
    me: vi.fn(async () => ({ role: 'player' })),
    authIdentify: vi.fn(),
    authRecover: vi.fn(),
    authResetPassword: vi.fn(),
    getAuthProviders: vi.fn(async () => ({ google_client_id: null, telegram_client_id: null })),
  },
  sessionRef: { current: null as unknown },
  setSessionMock: vi.fn(),
}));
vi.mock('../../../lib/api', () => ({ api: apiMock, ApiError: class extends Error { status = 0; }, hasAdminToken: () => false }));
vi.mock('../../../lib/identity', () => ({
  anonymousPlayerId: () => 'dev:test',
  getSession: () => sessionRef.current,
  setSession: setSessionMock,
  clearSession: vi.fn(),
  subscribeSession: () => () => {},
}));
vi.mock('../../../lib/session-actions', () => ({ logoutAndReset: vi.fn(async () => {}) }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }) }));

import AuthPage from '../page';

/** Walk the card to the «Письмо ушло» state for a confirmed account. */
async function openSentState() {
  apiMock.authIdentify.mockResolvedValue({ exists: true, confirmed: true });
  apiMock.authRecover.mockResolvedValue({ status: 'sent', masked: 'an***@gmail.com' });
  render(<AuthPage />);
  fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'anna@gmail.com' } });
  fireEvent.click(screen.getByRole('button', { name: 'Продолжить' }));
  await waitFor(() => expect(screen.getByText('С возвращением!')).toBeTruthy());
  fireEvent.click(screen.getByRole('button', { name: 'Забыли пароль?' }));
  fireEvent.click(screen.getByRole('button', { name: 'Отправить ссылку' }));
  await waitFor(() => expect(screen.getByText('Письмо ушло')).toBeTruthy());
}

beforeEach(() => {
  apiMock.authIdentify.mockReset();
  apiMock.authRecover.mockReset();
  apiMock.authResetPassword.mockReset();
  setSessionMock.mockReset();
  sessionRef.current = null;
});

describe('AuthPage — reset by code on the sent card (§6.2 R2)', () => {
  it('code + new password → resets, stores the session', async () => {
    await openSentState();
    const session = { token: 't', player_id: 'dev:test', email: 'anna@gmail.com', display_name: null, role: 'player' };
    apiMock.authResetPassword.mockResolvedValue(session);
    fireEvent.change(screen.getByLabelText('Код из письма'), { target: { value: '123456' } });
    fireEvent.change(screen.getByLabelText('Новый пароль'), { target: { value: 'password-123' } });
    fireEvent.click(screen.getByRole('button', { name: 'Сменить пароль и войти' }));
    await waitFor(() =>
      expect(apiMock.authResetPassword).toHaveBeenCalledExactlyOnceWith({
        email: 'anna@gmail.com',
        code: '123456',
        password: 'password-123',
      }),
    );
    expect(setSessionMock).toHaveBeenCalledExactlyOnceWith(session);
  });

  it('malformed code or short password is refused locally — no API call', async () => {
    await openSentState();
    fireEvent.change(screen.getByLabelText('Код из письма'), { target: { value: '12' } });
    fireEvent.change(screen.getByLabelText('Новый пароль'), { target: { value: 'password-123' } });
    fireEvent.click(screen.getByRole('button', { name: 'Сменить пароль и войти' }));
    expect(screen.getByText(/6 цифр/, { selector: '.af-error' })).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Код из письма'), { target: { value: '123456' } });
    fireEvent.change(screen.getByLabelText('Новый пароль'), { target: { value: 'short' } });
    fireEvent.click(screen.getByRole('button', { name: 'Сменить пароль и войти' }));
    expect(screen.getByText(/Минимум 8 символов/, { selector: '.af-error' })).toBeTruthy();
    expect(apiMock.authResetPassword).not.toHaveBeenCalled();
  });

  it('wrong/expired code (400) → explains, session untouched', async () => {
    await openSentState();
    apiMock.authResetPassword.mockRejectedValue(Object.assign(new Error('400'), { status: 400 }));
    fireEvent.change(screen.getByLabelText('Код из письма'), { target: { value: '654321' } });
    fireEvent.change(screen.getByLabelText('Новый пароль'), { target: { value: 'password-123' } });
    fireEvent.click(screen.getByRole('button', { name: 'Сменить пароль и войти' }));
    await waitFor(() => expect(screen.getByText(/Код не подошёл/)).toBeTruthy());
    expect(setSessionMock).not.toHaveBeenCalled();
  });

  it('unconfirmed account → confirmation copy, no code form', async () => {
    apiMock.authIdentify.mockResolvedValue({ exists: true, confirmed: false });
    apiMock.authRecover.mockResolvedValue({ status: 'sent', masked: 'an***@gmail.com' });
    render(<AuthPage />);
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'anna@gmail.com' } });
    fireEvent.click(screen.getByRole('button', { name: 'Продолжить' }));
    await waitFor(() => expect(screen.getByText('С возвращением!')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Забыли пароль?' }));
    fireEvent.click(screen.getByRole('button', { name: 'Отправить подтверждение' }));
    await waitFor(() => expect(screen.getByText('Письмо ушло')).toBeTruthy());
    expect(screen.getByText(/подтвержд/i)).toBeTruthy();
    expect(screen.queryByLabelText('Код из письма')).toBeNull();
  });
});
