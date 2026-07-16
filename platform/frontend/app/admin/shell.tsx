'use client';

import React, { useEffect, useState, useSyncExternalStore } from 'react';
import Link from 'next/link';
import { api, ApiError, hasAdminToken } from '../../lib/api';
import { getSession, subscribeSession } from '../../lib/identity';
import { logoutAndReset } from '../../lib/session-actions';

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
      <header className="ash-header">
        <div className="ash-bar">
          <Link className="logo ash-logo" href="/" aria-label="GEOHOD QUEST — на главную">
            <span className="ic logo-mark" />
            <span className="ic logo-text ash-logo-text" />
            <span className="ash-logo-stack">
              <span className="ash-logo-name">GEOHOD</span>
              <span className="ash-logo-sub">АДМИНКА</span>
            </span>
          </Link>
          <span className="ash-divider" aria-hidden />
          <span className="ash-eyebrow">АДМИНКА</span>
          <nav className="ash-tabs ash-tabs--inline" aria-label="Разделы админки">
            {TABS.map((t) => (
              <Link
                key={t.key}
                href={t.href}
                className={t.key === active ? 'is-active' : undefined}
                aria-current={t.key === active ? 'page' : undefined}
              >
                {t.label}
              </Link>
            ))}
          </nav>
          <AdminUserMenu />
        </div>
        <nav className="ash-tabs ash-tabs--row" aria-label="Разделы админки">
          {TABS.map((t) => (
            <Link
              key={t.key}
              href={t.href}
              className={t.key === active ? 'is-active' : undefined}
              aria-current={t.key === active ? 'page' : undefined}
            >
              {t.label}
            </Link>
          ))}
        </nav>
      </header>
      {children}
    </div>
  );
}

/**
 * The site-style user menu in the admin header (design: «меню пользователя как
 * на сайте»): avatar button with the presence dot, dropdown with мой профиль /
 * на сайт / выйти. An operator build without a session still gets the menu
 * (minus «выйти» — there is no session to end) so «на сайт» stays reachable.
 */
function AdminUserMenu() {
  const [menuOpen, setMenuOpen] = useState(false);
  const session = useSyncExternalStore(subscribeSession, getSession, () => null);

  useEffect(() => {
    if (!menuOpen) return;
    const onDoc = () => setMenuOpen(false);
    document.addEventListener('click', onDoc);
    return () => document.removeEventListener('click', onDoc);
  }, [menuOpen]);

  const handleLogout = () => {
    setMenuOpen(false);
    void logoutAndReset().finally(() => {
      window.location.href = '/';
    });
  };

  return (
    <div className={`user-menu ${menuOpen ? 'is-open' : ''}`}>
      <button
        className="user-menu__btn"
        type="button"
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        title="Профиль"
        onClick={(e) => {
          e.stopPropagation();
          setMenuOpen((v) => !v);
        }}
      >
        <span className="user-icon">
          <span className="head" />
          <span className="body" />
        </span>
        {session && <span className="user-menu__dot" aria-hidden />}
      </button>
      <div className="user-menu__dropdown" role="menu">
        <Link href="/profile" role="menuitem">мой профиль</Link>
        <Link href="/" role="menuitem">на сайт</Link>
        {session && (
          <button type="button" role="menuitem" onClick={handleLogout}>выйти</button>
        )}
      </div>
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
