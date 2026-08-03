'use client';

import React, { useEffect, useState, useSyncExternalStore } from 'react';
import Link from 'next/link';
import { getSession, subscribeSession } from '../../lib/identity';
import { api, ApiError, hasAdminToken } from '../../lib/api';
import { canEditQuests } from '../../lib/roles';
import WorkspaceGate from './WorkspaceGate';

/**
 * Role gate for the quest editor (admin-roles). Authoring is the `editor`
 * capability, so only editor/admin accounts — or an operator build carrying the
 * admin token — reach the Workspace; players and anonymous visitors get a clear
 * screen instead of an empty, dead editor.
 *
 * The matching backend guard (`require_editor`) rejects publish regardless, so
 * this is purely UX: it makes the surface fully closed instead of half-open.
 * The authoritative role comes from /api/users/me (the stored session role can
 * be stale), mirroring the /admin page; the token path admits the operator before
 * any editor/admin account exists.
 */
type Access = 'checking' | 'granted' | 'denied' | 'anon' | 'error';

export default function EditorGate() {
  // Subscribe to the session so logging in/out on this page re-runs the check.
  const session = useSyncExternalStore(subscribeSession, getSession, () => null);
  const [access, setAccess] = useState<Access>('checking');

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const tokenAdmin = hasAdminToken();
      try {
        const me = await api.me();
        if (cancelled) return;
        if (tokenAdmin || canEditQuests(me.role)) setAccess('granted');
        else setAccess(me.registered ? 'denied' : 'anon');
      } catch (err) {
        if (cancelled) return;
        if (tokenAdmin) {
          setAccess('granted');
          return;
        }
        // 401/403 → unauthenticated/anonymous identity; anything else → outage.
        const status = err instanceof ApiError ? err.status : null;
        setAccess(status === 401 || status === 403 ? 'anon' : 'error');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [session]);

  if (access === 'granted') return <WorkspaceGate />;
  if (access === 'checking') {
    // Same blank-canvas placeholder the Workspace itself uses while hydrating.
    return <div className="admin wsp" style={{ minHeight: '100vh' }} />;
  }
  return <EditorGateScreen access={access} />;
}

/** Full-screen "no access" / "sign in" / "outage" message for the editor gate. */
function EditorGateScreen({ access }: { access: Exclude<Access, 'checking' | 'granted'> }) {
  const anon = access === 'anon';
  const denied = access === 'denied';
  const title = denied ? 'Нет доступа' : anon ? 'Нужен вход' : 'Сервер недоступен';
  const text = denied
    ? 'Конструктор квестов доступен только редакторам и администраторам. Попросите администратора выдать вам роль редактора.'
    : anon
      ? 'Войдите под учётной записью редактора или администратора, чтобы открыть конструктор квестов.'
      : 'Не удалось проверить доступ к конструктору. Попробуйте обновить страницу позже.';
  const href = anon ? '/auth' : '/';
  const linkLabel = anon ? 'Войти' : 'На главную';

  return (
    <main
      style={{
        minHeight: '100vh',
        display: 'grid',
        placeItems: 'center',
        padding: '24px',
        background: '#f4f4f6',
        color: '#1b1b1f',
        fontFamily: 'system-ui, -apple-system, Segoe UI, Roboto, sans-serif',
      }}
    >
      <div
        style={{
          maxWidth: 420,
          width: '100%',
          textAlign: 'center',
          background: '#fff',
          borderRadius: 16,
          padding: '32px 24px',
          boxShadow: '0 8px 30px rgba(0,0,0,.08)',
        }}
      >
        <h1 style={{ margin: '0 0 12px', fontSize: 22, fontWeight: 700 }}>{title}</h1>
        <p style={{ margin: '0 0 24px', fontSize: 15, lineHeight: 1.5, color: '#4a4a52' }}>{text}</p>
        <Link
          href={href}
          style={{
            display: 'inline-block',
            padding: '10px 22px',
            borderRadius: 999,
            background: '#2B57D6',
            color: '#fff',
            fontWeight: 600,
            fontSize: 15,
            textDecoration: 'none',
          }}
        >
          {linkLabel}
        </Link>
      </div>
    </main>
  );
}
