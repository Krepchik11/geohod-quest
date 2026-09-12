'use client';

import React, { useEffect, useState, useSyncExternalStore } from 'react';
import Link from 'next/link';
import { useSelectedLayoutSegment } from 'next/navigation';
import { hasAdminToken, isAuthFailure } from '../../lib/api';
import { getSession, subscribeSession } from '../../lib/identity';
import { isAdmin } from '../../lib/roles';
import { fetchMe } from '../../lib/use-me';
import SpaceHeader from '../components/SpaceHeader';

// The admin desk's own stylesheets, mounted with the desk. Nobody outside
// /admin renders these classes, so nobody outside /admin downloads them.
import '../styles/admin-shell.css';
import '../styles/admin-page.css';
import '../styles/admin-users.css';
import '../styles/admin-coupons.css';
import '../styles/admin-features.css';
import '../styles/admin-stats.css';
import '../styles/admin-moderation.css';

/**
 * The ONE mount of the admin chrome (Admin Coupons.dc.html, «единый шелл»):
 * the SpaceHeader (site logo lockup + «АДМИНКА» + Jost tabs + user menu) over
 * the shared grey page canvas. As a route layout it persists across
 * navigations between admin pages, so switching tabs never remounts the
 * header and never re-runs the access check — the page body is the only thing
 * that changes. The gate below guarantees pages only mount once access is
 * granted, so they fetch unconditionally.
 */

const TABS = [
  { key: 'users', label: 'Пользователи', href: '/admin' },
  { key: 'coupons', label: 'Купоны', href: '/admin/coupons' },
  { key: 'features', label: 'Функции', href: '/admin/features' },
  { key: 'stats', label: 'Статистика', href: '/admin/stats' },
  { key: 'reviews', label: 'Отзывы', href: '/admin/reviews' },
  { key: 'feedback', label: 'Обратная связь', href: '/admin/feedback' },
];

type AdminAccess = 'checking' | 'granted' | 'denied' | 'error';

/**
 * Mount-time access gate: the operator token (NEXT_PUBLIC_ADMIN_TOKEN) or a
 * role==admin session grants access; the backend re-authorizes every
 * /api/admin/* call regardless (double gate). The role comes from the shared
 * token-keyed /me cache (lib/use-me), so the gate and the header's UserMenu
 * cost one network round-trip between them. Anonymous visitors can never be
 * admins, so without a session the verdict needs no request at all.
 */
function useAdminAccess(): AdminAccess {
  // Live session, like lib/use-me: SSR snapshot is null (anonymous),
  // reconciled on the client without a hydration mismatch.
  const session = useSyncExternalStore(subscribeSession, getSession, () => null);
  // The /me verdict, keyed by the token it was computed for so it is ignored
  // after a logout / account switch. Only the async fetch needs state — the
  // no-session verdicts derive at render, below.
  const [checked, setChecked] = useState<{ token: string; verdict: AdminAccess } | null>(null);
  useEffect(() => {
    if (!session) return;
    let cancelled = false;
    const token = session.token;
    const tokenAdmin = hasAdminToken();
    fetchMe(token)
      .then((me) => {
        if (!cancelled) {
          setChecked({ token, verdict: tokenAdmin || isAdmin(me.role) ? 'granted' : 'denied' });
        }
      })
      .catch((err) => {
        if (cancelled) return;
        if (tokenAdmin) {
          setChecked({ token, verdict: 'granted' });
          return;
        }
        setChecked({ token, verdict: isAuthFailure(err) ? 'denied' : 'error' });
      });
    return () => {
      cancelled = true;
    };
  }, [session]);
  // Anonymous visitors can never be admins — verdict without any request.
  if (!session) return hasAdminToken() ? 'granted' : 'denied';
  return checked?.token === session.token ? checked.verdict : 'checking';
}

/**
 * Access-state screens: spinner while checking, a clear Russian «Нет доступа»
 * / «Сервер недоступен» otherwise; children only when granted. Rendered under
 * the header so the chrome stays put.
 */
function AdminGate({ access, children }: { access: AdminAccess; children: React.ReactNode }) {
  if (access === 'checking') {
    return (
      <div className="ash-state">
        <span className="ash-spinner" aria-label="Загрузка" />
      </div>
    );
  }
  if (access !== 'granted') {
    const denied = access === 'denied';
    return (
      <div className="ash-state">
        <div className="ash-state-title">{denied ? 'Нет доступа' : 'Сервер недоступен'}</div>
        <div className="ash-state-text">
          {denied
            ? 'Эта страница доступна только администраторам. Войдите под учётной записью администратора.'
            : 'Не удалось связаться с сервером. Попробуйте обновить страницу позже.'}
        </div>
        <Link className="ash-state-link" href={denied ? '/auth' : '/'}>
          {denied ? 'Войти' : 'На главную'}
        </Link>
      </div>
    );
  }
  return <>{children}</>;
}

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  const access = useAdminAccess();
  // The router already knows which admin section we're in: the child segment
  // is null for /admin itself (the users tab) and the section name for every
  // nested route (/admin/coupons/new → 'coupons') — no path parsing needed.
  const active = useSelectedLayoutSegment() ?? 'users';
  return (
    <div className="ash-root">
      <SpaceHeader eyebrow="АДМИНКА" tabs={TABS} active={active} tabsLabel="Разделы админки" />
      <AdminGate access={access}>
        <div className="ap-root">{children}</div>
      </AdminGate>
    </div>
  );
}
