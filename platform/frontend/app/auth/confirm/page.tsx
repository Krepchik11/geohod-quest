'use client';

import React, { Suspense, useEffect, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { api } from '../../../lib/api';

/**
 * §6.3 — /auth/confirm?token=…: the mailed confirmation link lands here.
 * Consumes the token once; the account already works either way (soft
 * confirmation) — this only unlocks password recovery.
 */
function ConfirmInner() {
  const token = useSearchParams().get('token') ?? '';
  const [state, setState] = useState<'working' | 'done' | 'bad'>(() => (token ? 'working' : 'bad'));
  const [email, setEmail] = useState<string | null>(null);

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    api.authConfirmEmail(token)
      .then((r) => { if (!cancelled) { setEmail(r.email); setState('done'); } })
      .catch(() => { if (!cancelled) setState('bad'); });
    return () => { cancelled = true; };
  }, [token]);

  return (
    <div className="af-card card">
      <Link className="af-close" href="/" aria-label="Закрыть">✕</Link>
      {state === 'working' && <p className="af-sub">Подтверждаем почту…</p>}
      {state === 'done' && (
        <div className="af-sent">
          <span className="af-sent__icon" aria-hidden>✓</span>
          <b>Почта подтверждена</b>
          <p>{email} — теперь доступно восстановление пароля по этой почте.</p>
          <Link className="btn btn--md" href="/profile">В профиль</Link>
        </div>
      )}
      {state === 'bad' && (
        <>
          <h2 className="af-title">Ссылка не сработала</h2>
          <p className="af-sub">Ссылка недействительна или устарела. Запросите новое письмо из профиля — кнопка «Ещё раз» в баннере подтверждения.</p>
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
