// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import React from 'react';

/**
 * §6.1 email-first auth flow. The server decides the mode (identify), so the
 * user can't pick the wrong one — the old two-pill toggle and its 409 class
 * are gone by construction.
 */
const { apiMock, sessionRef } = vi.hoisted(() => ({
  apiMock: {
    me: vi.fn(async () => ({ role: 'player' })),
    authIdentify: vi.fn(),
    authLogin: vi.fn(),
    authRegister: vi.fn(),
    authRecover: vi.fn(),
  },
  sessionRef: { current: null as unknown },
}));
vi.mock('../../../lib/api', () => ({ api: apiMock, ApiError: class extends Error { status = 0; }, hasAdminToken: () => false }));
vi.mock('../../../lib/identity', () => ({
  anonymousPlayerId: () => 'dev:test',
  getSession: () => sessionRef.current,
  setSession: vi.fn((s: unknown) => { sessionRef.current = s; }),
  clearSession: vi.fn(),
  subscribeSession: () => () => {},
}));
vi.mock('../../../lib/session-actions', () => ({ logoutAndReset: vi.fn(async () => {}) }));

import AuthPage from '../page';

beforeEach(() => {
  apiMock.authIdentify.mockReset();
  apiMock.authLogin.mockReset();
  apiMock.authRegister.mockReset();
  apiMock.authRecover.mockReset();
  sessionRef.current = null;
});

async function enterEmail(email: string) {
  fireEvent.change(screen.getByLabelText('Email'), { target: { value: email } });
  fireEvent.click(screen.getByRole('button', { name: 'Продолжить' }));
}

describe('AuthPage — email-first (§6.1)', () => {
  it('step 1 shows only the email field and the honest anonymous note', () => {
    render(<AuthPage />);
    expect(screen.getByText('Вход или регистрация')).toBeTruthy();
    expect(screen.getByText(/Аккаунт сохранит покупки, монеты и прогресс/)).toBeTruthy();
    expect(screen.getByText(/Играть можно и без аккаунта/)).toBeTruthy();
    expect(screen.queryByLabelText(/Пароль/)).toBeNull();
  });

  it('known email → «С возвращением!» login step; wrong password errors at the field', async () => {
    apiMock.authIdentify.mockResolvedValue({ exists: true, confirmed: true });
    apiMock.authLogin.mockRejectedValue(Object.assign(new Error('401'), { status: 401 }));
    render(<AuthPage />);
    await enterEmail('anna@gmail.com');
    await waitFor(() => expect(screen.getByText('С возвращением!')).toBeTruthy());
    expect(screen.getByText('anna@gmail.com')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Пароль'), { target: { value: 'wrong-pass-1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Войти' }));
    await waitFor(() => expect(screen.getByText(/Неверный пароль\./)).toBeTruthy());
    expect(screen.getByText('Восстановить?')).toBeTruthy();
  });

  it('new email → «Создадим аккаунт» with consent gating registration', async () => {
    apiMock.authIdentify.mockResolvedValue({ exists: false, confirmed: false });
    apiMock.authRegister.mockResolvedValue({ token: 't', player_id: 'dev:test', email: 'novy@gmail.com', display_name: null, role: 'player' });
    render(<AuthPage />);
    await enterEmail('novy@gmail.com');
    await waitFor(() => expect(screen.getByText('Создадим аккаунт')).toBeTruthy());
    expect(screen.getByText(/Монеты и покупки этого устройства привяжутся к аккаунту/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Придумайте пароль'), { target: { value: 'password-123' } });
    // Without consent the submit is refused.
    fireEvent.click(screen.getByRole('button', { name: 'Зарегистрироваться' }));
    expect(apiMock.authRegister).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: 'Зарегистрироваться' }));
    await waitFor(() =>
      expect(apiMock.authRegister).toHaveBeenCalledWith({
        player_id: 'dev:test',
        email: 'novy@gmail.com',
        password: 'password-123',
      }),
    );
  });

  it('«изменить» returns to the email step', async () => {
    apiMock.authIdentify.mockResolvedValue({ exists: true, confirmed: true });
    render(<AuthPage />);
    await enterEmail('anna@gmail.com');
    await waitFor(() => screen.getByText('С возвращением!'));
    fireEvent.click(screen.getByRole('button', { name: 'изменить' }));
    expect(screen.getByText('Вход или регистрация')).toBeTruthy();
  });

  it('«Забыли пароль?» → recovery request → sent state with masked email', async () => {
    apiMock.authIdentify.mockResolvedValue({ exists: true, confirmed: true });
    apiMock.authRecover.mockResolvedValue({ status: 'sent', masked: 'an***@gmail.com' });
    render(<AuthPage />);
    await enterEmail('anna@gmail.com');
    await waitFor(() => screen.getByText('С возвращением!'));
    fireEvent.click(screen.getByText('Забыли пароль?'));
    expect(screen.getByText('Восстановление пароля')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Отправить ссылку' }));
    await waitFor(() => expect(screen.getByText('Письмо ушло')).toBeTruthy());
    expect(screen.getByText(/an\*\*\*@gmail.com действует 30 минут/)).toBeTruthy();
  });

  it('the ✕ link navigates home, never history.back()', () => {
    render(<AuthPage />);
    const close = screen.getByLabelText('Закрыть');
    expect(close.getAttribute('href')).toBe('/');
  });
});
