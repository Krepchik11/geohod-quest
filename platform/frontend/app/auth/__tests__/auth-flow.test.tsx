// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ApiError } from '../../../lib/api';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import React from 'react';

/**
 * §6.1 email-first auth flow. The server decides the mode (identify), so the
 * user can't pick the wrong one — the old two-pill toggle and its 409 class
 * are gone by construction.
 */
const { apiMock, sessionRef, routerMock } = vi.hoisted(() => ({
  apiMock: {
    me: vi.fn(async () => ({ role: 'player' })),
    authIdentify: vi.fn(),
    authLogin: vi.fn(),
    authRegister: vi.fn(),
    authRecover: vi.fn(),
    getAuthProviders: vi.fn(async () => ({ google_client_id: null, telegram_client_id: null })),
  },
  sessionRef: { current: null as unknown },
  routerMock: { push: vi.fn(), replace: vi.fn(), back: vi.fn() },
}));
vi.mock('../../../lib/api', async (importOriginal) => ({ ...(await importOriginal<object>()), api: apiMock, hasAdminToken: () => false }));
vi.mock('../../../lib/identity', () => ({
  anonymousUserId: () => 'dev:test',
  getSession: () => sessionRef.current,
  setSession: vi.fn((s: unknown) => { sessionRef.current = s; }),
  clearSession: vi.fn(),
  subscribeSession: () => () => {},
}));
vi.mock('../../../lib/session-actions', () => ({ logoutAndReset: vi.fn(async () => {}) }));
vi.mock('next/navigation', () => ({ useRouter: () => routerMock }));

import AuthPage from '../page';

beforeEach(() => {
  apiMock.authIdentify.mockReset();
  apiMock.authLogin.mockReset();
  apiMock.authRegister.mockReset();
  apiMock.authRecover.mockReset();
  routerMock.replace.mockReset();
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
    apiMock.authLogin.mockRejectedValue(new ApiError(401, '/api/auth/login', ''));
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
    apiMock.authRegister.mockResolvedValue({ token: 't', user_id: 'dev:test', email: 'novy@gmail.com', display_name: null, role: 'player' });
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
        user_id: 'dev:test',
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
    expect(screen.getByText(/код и ссылку на an\*\*\*@gmail.com — действуют 30 минут/)).toBeTruthy();
  });

  it('successful login redirects straight to the main page — no interim card', async () => {
    apiMock.authIdentify.mockResolvedValue({ exists: true, confirmed: true });
    apiMock.authLogin.mockResolvedValue({ token: 't', user_id: 'dev:test', email: 'anna@gmail.com', display_name: null, role: 'player' });
    render(<AuthPage />);
    await enterEmail('anna@gmail.com');
    await waitFor(() => screen.getByText('С возвращением!'));
    fireEvent.change(screen.getByLabelText('Пароль'), { target: { value: 'correct-pass-1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Войти' }));
    await waitFor(() => expect(routerMock.replace).toHaveBeenCalledWith('/'));
    expect(screen.queryByText('Вы вошли')).toBeNull();
  });

  it('an already-signed-in visitor is redirected home instead of seeing a card', () => {
    sessionRef.current = { token: 't', user_id: 'dev:test', email: 'anna@gmail.com', display_name: null, role: 'player' };
    render(<AuthPage />);
    expect(routerMock.replace).toHaveBeenCalledWith('/');
    expect(screen.queryByText('Вы вошли')).toBeNull();
  });

  it('the ✕ link navigates home, never history.back()', () => {
    render(<AuthPage />);
    const close = screen.getByLabelText('Закрыть');
    expect(close.getAttribute('href')).toBe('/');
  });
});
