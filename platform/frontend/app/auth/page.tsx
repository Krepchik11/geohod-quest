'use client';

import React, { useCallback, useState, useSyncExternalStore } from 'react';
import SiteHeader from '../SiteHeader';
import { api } from '../../lib/api';
import {
  anonymousPlayerId,
  clearSession,
  getSession,
  setSession,
  subscribeSession,
  type Session,
} from '../../lib/identity';
import { logoutAndReset } from '../../lib/session-actions';

/**
 * Вход / регистрация — email + пароль (owner requirement supersedes the design's
 * Telegram button; card structure, classes and consent checkbox kept per
 * design/auth). Registration is OPTIONAL: anonymous play works on the device id;
 * registering attaches email to the SAME player id, so purchases and coins
 * survive (player-identity spec). No email confirmation. Login on another
 * device adopts the account identity.
 */
type Mode = 'login' | 'register';

export default function AuthPage() {
  const [mode, setMode] = useState<Mode>('register');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [checked, setChecked] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const session: Session | null = useSyncExternalStore(subscribeSession, getSession, () => null);

  // setSession/clearSession notify the shared store themselves, so subscribers
  // (this page's session view, the header) update without a manual bump.
  const applySession = useCallback((s: Session | null) => {
    if (s) setSession(s);
    else clearSession();
  }, []);

  const submit = async () => {
    setError(null);
    if (mode === 'register' && !checked) {
      setError('Согласие с политикой обязательно для регистрации');
      return;
    }
    if (!email.trim() || password.length < 8) {
      setError('Укажите email и пароль не короче 8 символов');
      return;
    }
    setLoading(true);
    try {
      const result =
        mode === 'register'
          ? await api.authRegister({ player_id: anonymousPlayerId(), email: email.trim(), password })
          : await api.authLogin({ email: email.trim(), password });
      applySession(result);
    } catch (e) {
      const msg = (e as Error).message;
      if (msg.includes('409')) setError('Этот email или устройство уже зарегистрированы — попробуйте войти');
      else if (msg.includes('401')) setError('Неверный email или пароль');
      else if (msg.includes('400')) setError('Проверьте email и пароль (минимум 8 символов)');
      else setError('Сервер недоступен — попробуйте позже');
    } finally {
      setLoading(false);
    }
  };

  const logout = () => {
    // Flush, clear+rotate the session, and wipe local play (see session-actions);
    // clearSession inside it notifies the shared store, flipping this view back to
    // the login form.
    void logoutAndReset();
    setEmail('');
    setPassword('');
  };

  if (session) {
    return (
      <div className="site" style={{ background: 'var(--bg-light)' }}>
        <SiteHeader />
        <div className="auth-wrap">
          <div className="auth-card card">
            <div className="auth-title">Вы вошли</div>
            <p style={{ margin: '12px 0' }}>
              <b>{session.email}</b>
              <br />
              <span style={{ fontSize: 12, opacity: 0.7 }}>
                Покупки и монеты привязаны к аккаунту — войдите с любого устройства.
              </span>
            </p>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <a className="btn" href="/profile">Мой профиль</a>
              <a className="btn" href="/my-quests">Мои квесты</a>
              <button className="btn" type="button" onClick={logout}>Выйти</button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="site" style={{ background: 'var(--bg-light)' }}>
      <SiteHeader />
      <div className="auth-wrap">
        <div className={`auth-card card ${error ? 'show-error' : ''}`}>
          <button className="auth-card__close" onClick={() => window.history.back()}>✕</button>
          <div className="auth-title">Вход / регистрация</div>

          <p style={{ fontSize: 12, opacity: 0.75, margin: '4px 0 12px' }}>
            Регистрация не обязательна — играть можно анонимно. Аккаунт сохранит покупки
            и монеты при смене устройства. Email-подтверждение не требуется.
          </p>

          <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
            <button
              className="btn"
              type="button"
              style={{ opacity: mode === 'register' ? 1 : 0.55 }}
              onClick={() => { setMode('register'); setError(null); }}
            >
              Регистрация
            </button>
            <button
              className="btn"
              type="button"
              style={{ opacity: mode === 'login' ? 1 : 0.55 }}
              onClick={() => { setMode('login'); setError(null); }}
            >
              Вход
            </button>
          </div>

          <input
            className="s-input"
            style={{ width: '100%', marginBottom: 8 }}
            type="email"
            placeholder="Email"
            value={email}
            autoComplete="email"
            onChange={(e) => setEmail(e.target.value)}
          />
          <input
            className="s-input"
            style={{ width: '100%', marginBottom: 8 }}
            type="password"
            placeholder="Пароль (минимум 8 символов)"
            value={password}
            autoComplete={mode === 'register' ? 'new-password' : 'current-password'}
            onChange={(e) => setPassword(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void submit(); }}
          />

          {mode === 'register' && (
            <label className="auth-policy" onClick={() => setChecked(!checked)}>
              <input type="checkbox" checked={checked} onChange={(e) => setChecked(e.target.checked)} />
              <span className="box" />
              <span>Я согласен с <a href="#">политикой конфиденциальности</a> и <a href="#">пользовательским соглашением</a></span>
            </label>
          )}
          {error && <div className="auth-error" style={{ display: 'block' }}>{error}</div>}

          <button className="btn" type="button" style={{ width: '100%', marginTop: 12 }} disabled={loading} onClick={() => void submit()}>
            {loading ? 'Загрузка…' : mode === 'register' ? 'Зарегистрироваться' : 'Войти'}
          </button>
        </div>
      </div>
    </div>
  );
}
