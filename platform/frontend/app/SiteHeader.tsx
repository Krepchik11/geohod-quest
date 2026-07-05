'use client';

import React, { useState, useEffect, useSyncExternalStore } from 'react';
import Link from 'next/link';
import { getSession, subscribeSession } from '../lib/identity';
import { logoutAndReset } from '../lib/session-actions';
import { api, hasAdminToken } from '../lib/api';
import { canEditQuests, isAdmin } from '../lib/roles';

/**
 * SiteHeader v2 (§2.5, §1.2) — logo + nav + auth slot.
 *
 * Auth slot is honest about state: anonymous visitors see a text pill «Войти»
 * (the bare icon button never shows for them); signed-in users see the avatar
 * circle with a green presence dot that opens the profile dropdown with a REAL
 * «выйти» (clears the session and rotates the device id — lib/identity).
 *
 * Mobile (<768px): the inline nav is hidden — navigation moves to the bottom
 * tab bar (components/TabBar) — so the header is just logo + auth slot. The old
 * hamburger drawer is gone with it.
 */
export default function SiteHeader() {
  const [menuOpen, setMenuOpen] = useState(false);
  // SSR snapshot is null (anonymous) — useSyncExternalStore reconciles to the real
  // session on the client without a hydration mismatch.
  const session = useSyncExternalStore(subscribeSession, getSession, () => null);

  // The role stored in the session is a snapshot from login and can be STALE — e.g.
  // you registered (default role player) and were then promoted to admin/editor via
  // the ops token, so the menu would never reveal the admin/editor links until a
  // re-login. Re-fetch the authoritative role from /api/players/me so role changes
  // surface immediately. The result is keyed by the session token it belongs to, so
  // it is ignored after a logout / account switch (no cross-account leak) and no
  // synchronous setState is needed in the effect body.
  const [fetched, setFetched] = useState<{ token: string; role: string | null } | null>(null);
  useEffect(() => {
    if (!session) return;
    let cancelled = false;
    const token = session.token;
    void api
      .me()
      .then((me) => {
        if (!cancelled) setFetched({ token, role: me.role });
      })
      .catch(() => {
        /* offline / transient: keep using the session-snapshot role */
      });
    return () => {
      cancelled = true;
    };
  }, [session]);

  // Authoritative role once /me resolves for THIS session; the login-time session
  // snapshot (possibly stale) is the instant, offline-safe fallback.
  const role = session
    ? fetched && fetched.token === session.token
      ? fetched.role
      : session.role
    : undefined;

  // Click-outside closes the profile dropdown.
  useEffect(() => {
    if (!menuOpen) return;
    const onDoc = () => setMenuOpen(false);
    document.addEventListener('click', onDoc);
    return () => document.removeEventListener('click', onDoc);
  }, [menuOpen]);

  const toggleMenu = (e: React.MouseEvent) => {
    e.stopPropagation();
    setMenuOpen(v => !v);
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
    <header className="site-header container">
      <Link className="logo" href="/" aria-label="GEOHOD QUEST — на главную">
        <span className="ic logo-mark" />
        <span className="ic logo-text" />
      </Link>

      <nav className="site-nav" aria-label="Основная навигация">
        <Link href="/">главная</Link>
        <Link href="/#shop">магазин квестов</Link>
        <Link href="/my-quests">мои квесты</Link>
        {/* §1.3: absolute anchor so «контакты» works from every page, not just /. */}
        <Link href="/#contacts">контакты</Link>
      </nav>

      {session ? (
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
            <span className="user-menu__dot" aria-hidden />
          </button>
          <div className="user-menu__dropdown" role="menu">
            <Link href="/profile" role="menuitem">мой профиль</Link>
            {/* Role-gated nav (admin-roles). The role comes from the stored session, so
                it can be briefly stale; the destination pages AND the backend re-check
                authorization regardless, so a stale link can only ever lead to a clean
                "no access" screen, never real access. The admin-token path admits an
                operator build before any admin/editor account exists. */}
            {(isAdmin(role) || hasAdminToken()) && (
              <Link href="/admin" role="menuitem">админка</Link>
            )}
            {/* Quest editor — editors and admins only (authoring capability). */}
            {(canEditQuests(role) || hasAdminToken()) && (
              <Link href="/quest-editor" role="menuitem">редактор</Link>
            )}
            <button type="button" role="menuitem" onClick={handleLogout}>выйти</button>
          </div>
        </div>
      ) : (
        // §2.5: anonymous users get a text pill, never the bare icon button.
        <Link className="header-login" href="/auth">Войти</Link>
      )}
    </header>
  );
}
