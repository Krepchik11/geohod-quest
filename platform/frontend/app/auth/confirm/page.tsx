'use client';

import React, { Suspense, useEffect, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { api, classify } from '../../../lib/api';

/**
 * §6.3/§6.4 — /auth/confirm?token=…: both mailed links land here. A
 * first-confirmation token unlocks password recovery; an email-change token
 * applies the pending new address (the backend's `changed` flag names which).
 */
function ConfirmInner() {
  const token = useSearchParams().get('token') ?? '';
  const [state, setState] = useState<'working' | 'done' | 'changed' | 'taken' | 'bad'>(() =>
    token ? 'working' : 'bad',
  );
  const [email, setEmail] = useState<string | null>(null);

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    api.authConfirmEmail(token)
      .then((r) => { if (!cancelled) { setEmail(r.email); setState(r.changed ? 'changed' : 'done'); } })
      .catch((e) => {
        if (cancelled) return;
        const f = classify(e);
        // The address was taken between the request and this click — a fresh
        // request is the only way forward, retrying this link never helps.
        setState(f.kind === 'rejected' && f.status === 409 ? 'taken' : 'bad');
      });
    return () => { cancelled = true; };
  }, [token]);

  return (
    <div className="af-card card">
      <Link className="af-close" href="/" aria-label="Закрыть">✕</Link>
      {state === 'working' && <p className="af-sub">Подтверждаем почту…</p>}
      {(state === 'done' || state === 'changed') && (
        <div className="af-sent">
          <span className="af-sent__icon" aria-hidden>✓</span>
          <b>{state === 'changed' ? 'Почта изменена' : 'Почта подтверждена'}</b>
          <p>
            {email}
            {state === 'changed'
              ? ' — теперь это адрес вашего аккаунта.'
              : ' — теперь доступно восстановление пароля по этой почте.'}
          </p>
          <Link className="btn btn--md" href="/profile">В профиль</Link>
        </div>
      )}
      {state === 'taken' && (
        <>
          <h2 className="af-title">Адрес уже занят</h2>
          <p className="af-sub">Пока письмо шло, эту почту привязал другой аккаунт. Запросите смену на другой адрес из профиля.</p>
          <Link className="btn btn--block btn--secondary" href="/profile">В профиль</Link>
        </>
      )}
      {state === 'bad' && (
        <>
          <h2 className="af-title">Ссылка не сработала</h2>
          <p className="af-sub">Ссылка недействительна или устарела. Запросите новое письмо из профиля.</p>
          <Link className="btn btn--block btn--secondary" href="/profile">В профиль</Link>
        </>
      )}
    </div>
  );
}

export default function ConfirmPage() {
  return (
    <Suspense fallback={null}>
      <ConfirmInner />
    </Suspense>
  );
}
