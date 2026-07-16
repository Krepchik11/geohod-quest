'use client';

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { api, ApiError, hasAdminToken } from '../../lib/api';
import SpaceHeader from '../components/SpaceHeader';

/**
 * Unified admin shell (Admin Coupons.dc.html, «единый шелл»): one header for
 * every admin page — the site logo lockup + «АДМИНКА», Jost tabs styled like
 * the public site-nav, and the site-style user menu (мой профиль / на сайт /
 * выйти) instead of the old bare avatar link. Desktop is a single 72px row
 * with centered tabs; mobile stacks the tabs into a second row.
 *
 */

export type AdminTab = 'users' | 'coupons' | 'features' | 'stats';

const TABS: Array<{ key: AdminTab; label: string; href: string }> = [
  { key: 'users', label: 'Пользователи', href: '/admin' },
  { key: 'coupons', label: 'Купоны', href: '/admin/coupons' },
  { key: 'features', label: 'Функции', href: '/admin/features' },
  { key: 'stats', label: 'Статистика', href: '/admin/stats' },
];

export type AdminAccess = 'checking' | 'granted' | 'denied' | 'error';

/**
 * Mount-time access gate shared by every admin page: the operator token
 * (NEXT_PUBLIC_ADMIN_TOKEN) or a role==admin session grants access; the
 * backend re-authorizes every /api/admin/* call regardless (double gate).
 */
export function useAdminAccess(): AdminAccess {
  const [access, setAccess] = useState<AdminAccess>('checking');
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const tokenAdmin = hasAdminToken();
      let granted = tokenAdmin;
      try {
        const me = await api.me();
        if (me.role === 'admin') granted = true;
      } catch (err) {
        if (!tokenAdmin) {
          const status = err instanceof ApiError ? err.status : null;
          if (!cancelled) setAccess(status === 401 || status === 403 ? 'denied' : 'error');
          return;
        }
      }
      if (!cancelled) setAccess(granted ? 'granted' : 'denied');
    })();
    return () => {
      cancelled = true;
    };
  }, []);
  return access;
}

/** The shared chrome: header (brand + tabs + user menu) above the page body. */
export default function AdminShell({
  active,
  children,
}: {
  active: AdminTab;
  children: React.ReactNode;
}) {
  return (
    <div className="ash-root">
      <SpaceHeader eyebrow="АДМИНКА" tabs={TABS} active={active} tabsLabel="Разделы админки" />
      {children}
    </div>
  );
}

/**
 * Access-state screens shared by admin pages: spinner while checking, a clear
 * Russian «Нет доступа» / «Сервер недоступен» otherwise; children only when
 * granted. Rendered INSIDE the shell so the chrome stays put.
 */
export function AdminGate({
  access,
  children,
}: {
  access: AdminAccess;
  children: React.ReactNode;
}) {
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
