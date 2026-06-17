'use client';

import React, { useState, useEffect, useSyncExternalStore } from 'react';
import Link from 'next/link';
import { getSession, subscribeSession } from '../lib/identity';
import { logoutAndReset } from '../lib/session-actions';
import { hasAdminToken } from '../lib/api';
import { canEditQuests, isAdmin } from '../lib/roles';

/**
 * SiteHeader — visual + behavior port from the design site header.
 * Client state: user dropdown + (mobile) nav drawer, both click-outside close.
 *
 * Session-aware: subscribes to the shared identity store so the user menu reflects
 * login state live. Anonymous visitors get a single «войти / регистрация» entry;
 * logged-in users get profile + editor + a REAL «выйти» that clears the session
 * and rotates the device id (see lib/identity.clearSession). The old menu had a
 * dead «выход» link that only navigated to /auth and never logged anyone out.
 *
 * Mobile: the desktop inline nav cannot fit a phone, so below 768px a
 * .nav-toggle hamburger (styled in styles/responsive.css) reveals the nav as
 * a dropdown panel. Desktop markup/layout is unchanged — the toggle is
 * display:none until the phone tier, so it stays out of the flex flow.
 */
export default function SiteHeader() {
  const [menuOpen, setMenuOpen] = useState(false);
  const [navOpen, setNavOpen] = useState(false);
  // SSR snapshot is null (anonymous) — useSyncExternalStore reconciles to the real
  // session on the client without a hydration mismatch.
  const session = useSyncExternalStore(subscribeSession, getSession, () => null);

  // Single document listener closes whichever popover is open (click-outside).
  useEffect(() => {
    if (!menuOpen && !navOpen) return;
    const onDoc = () => { setMenuOpen(false); setNavOpen(false); };
    document.addEventListener('click', onDoc);
    return () => document.removeEventListener('click', onDoc);
  }, [menuOpen, navOpen]);

  const toggleMenu = (e: React.MouseEvent) => {
    e.stopPropagation();
    setNavOpen(false);
    setMenuOpen(v => !v);
  };

  const toggleNav = (e: React.MouseEvent) => {
    e.stopPropagation();
    setMenuOpen(false);
    setNavOpen(v => !v);
  };

  const handleLogout = () => {
    setMenuOpen(false);
    // Flush pending facts, clear the session + rotate the device id (un-bricks
    // anonymous use), and wipe local play — then full-navigate home so every island
    // re-reads the fresh anonymous identity.
    void logoutAndReset().finally(() => {
      window.location.href = '/';
    });
  };

  return (
    <header className={`site-header container ${navOpen ? 'is-nav-open' : ''}`}>
      <button
        className="nav-toggle"
        type="button"
        aria-label="Меню"
        aria-expanded={navOpen}
        onClick={toggleNav}
      >
        <span className="bars" />
      </button>

      <Link className="logo" href="/" aria-label="GEOHOD QUEST — на главную">
        <span className="ic logo-mark" />
        <span className="ic logo-text" />
      </Link>

      {/* Clicking any link navigates and closes the mobile drawer. */}
      <nav className="site-nav" aria-label="Основная навигация" onClick={() => setNavOpen(false)}>
        <Link href="/">главная</Link>
        <Link href="/#shop">магазин квестов</Link>
        <Link href="/my-quests">мои квесты</Link>
        <a href="#contacts">контакты</a>
      </nav>

      <div className={`user-menu ${menuOpen ? 'is-open' : ''}`}>
        <button
          className="user-menu__btn"
          type="button"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          title="Профиль"
          onClick={toggleMenu}
        >
          <span className="user-icon">
            <span className="head" />
            <span className="body" />
          </span>
        </button>
        <div className="user-menu__dropdown" role="menu">
          <Link href="/profile" role="menuitem">мой профиль</Link>
          {/* Role-gated nav (admin-roles). The role comes from the stored session, so
              it can be briefly stale; the destination pages AND the backend re-check
              authorization regardless, so a stale link can only ever lead to a clean
              "no access" screen, never real access. The admin-token path admits an
              operator build before any admin/editor account exists. */}
          {(isAdmin(session?.role) || hasAdminToken()) && (
            <Link href="/admin" role="menuitem">админка</Link>
          )}
          {session ? (
            <>
              {/* Quest editor — editors and admins only (authoring capability). */}
              {(canEditQuests(session.role) || hasAdminToken()) && (
                <Link href="/quest-editor" role="menuitem">редактор</Link>
              )}
              <button type="button" role="menuitem" onClick={handleLogout}>выйти</button>
            </>
          ) : (
            <Link href="/auth" role="menuitem">войти / регистрация</Link>
          )}
        </div>
      </div>
    </header>
  );
}
