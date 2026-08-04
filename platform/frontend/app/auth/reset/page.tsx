'use client';

import React, { Suspense, useState } from 'react';
import Link from 'next/link';
import { useSearchParams, useRouter } from 'next/navigation';
import { api } from '../../../lib/api';
import { PASSWORD_ERROR, passwordValid } from '../../../lib/credentials';
import { setSession } from '../../../lib/identity';
import { PasswordField } from '../page';

/**
 * §6.2 — /auth/reset?token=…: the mailed R1 link lands here. New password
 * (min 8, «Показать») → success → signed in (the backend returns a session).
 */
function ResetInner() {
  const token = useSearchParams().get('token') ?? '';
  const router = useRouter();
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const submit = async () => {
    if (!passwordValid(password)) {
      setError(PASSWORD_ERROR);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      setSession(await api.authResetPassword({ token, password }));
      router.push('/profile');
    } catch (e) {
      const status = (e as { status?: number })?.status;
      setError(
        status === 400
          ? 'Ссылка недействительна или устарела — запросите новую на странице входа.'
          : 'Сервер недоступен — попробуйте позже.',
      );
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="af-card card">
      <Link className="af-close" href="/" aria-label="Закрыть">✕</Link>
      <h2 className="af-title">Новый пароль</h2>
      {token ? (
        <>
          <PasswordField
            label="Придумайте пароль"
            value={password}
            hint="Минимум 8 символов"
            autoComplete="new-password"
            onChange={setPassword}
            onEnter={() => void submit()}
          />
          {error && <p className="af-error">{error}</p>}
          <button className="btn btn--block" type="button" disabled={loading} onClick={() => void submit()}>
            {loading ? 'Сохраняем…' : 'Сменить пароль и войти'}
          </button>
        </>
      ) : (
        <>
          <p className="af-sub">В ссылке нет кода восстановления — откройте её из письма ещё раз.</p>
          <Link className="btn btn--block btn--secondary" href="/auth">Ко входу</Link>
        </>
      )}
    </div>
  );
}

export default function ResetPage() {
  return (
    <Suspense fallback={null}>
      <ResetInner />
    </Suspense>
  );
}
