'use client';

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import UserMenu from './components/UserMenu';
import { hasAdminToken } from '../lib/api';
import { canEditQuests, isAdmin } from '../lib/roles';
import { useMe } from '../lib/use-me';

/**
 * SiteHeader v2 (§2.5, §1.2) — logo + nav + auth slot.
 *
 * The nav lists every site section the viewer may enter — including the
 * role-gated «админка» and «редактор» (they are sections, not profile
 * actions, so they live here next to the others, not in the profile
 * dropdown). The role comes from useMe (authoritative /me with the session
 * snapshot as fallback); a briefly-stale link can only ever lead to a clean
 * "no access" screen — the destination pages and the backend re-check
 * authorization regardless. The admin-token path admits an operator build
 * before any admin/editor account exists.
 *
 * Auth slot is the shared UserMenu: anonymous visitors see a text pill
 * «Войти» (the bare icon button never shows for them); signed-in users see
 * the avatar circle with the presence dot and the profile dropdown.
 *
 * Mobile (<768px): the inline nav collapses behind the burger button and drops
 * down as a panel with the same sections — the only navigation on a phone since
 * the bottom tab bar was removed.
 */
export default function SiteHeader() {
  const { role, session } = useMe();
  const [navOpen, setNavOpen] = useState(false);

  // Click-outside closes the panel, as in UserMenu.
  useEffect(() => {
    if (!navOpen) return;
    const onDoc = () => setNavOpen(false);
    document.addEventListener('click', onDoc);
    return () => document.removeEventListener('click', onDoc);
  }, [navOpen]);

  return (
    <header className="site-header container">
      <Link className="logo" href="/" aria-label="GEOHOD QUEST — на главную">
        <span className="ic logo-mark" />
        <span className="ic logo-text" />
      </Link>

      <button
        className="nav-toggle"
        type="button"
        aria-label="Меню"
        aria-expanded={navOpen}
        aria-controls="site-nav"
        onClick={(e) => {
          e.stopPropagation();
          setNavOpen((v) => !v);
        }}
      >
        <svg width="22" height="16" viewBox="0 0 22 16" fill="none" aria-hidden>
          <path d="M1 1h20M1 8h20M1 15h20" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        </svg>
      </button>

      <nav
        id="site-nav"
        className={`site-nav ${navOpen ? 'is-open' : ''}`}
        aria-label="Основная навигация"
        onClick={() => setNavOpen(false)}
      >
        <Link href="/">главная</Link>
        <Link href="/#shop">квесты</Link>
        <Link href="/rules">как играть</Link>
        {/* §1.3: absolute anchor so «контакты» works from every page, not just /. */}
        <Link href="/#contacts">контакты</Link>
        {(canEditQuests(role) || hasAdminToken()) && (
          <Link href="/quest-editor">редактор</Link>
        )}
        {(isAdmin(role) || hasAdminToken()) && (
          <Link href="/admin">админка</Link>
        )}
        {/* Phone only (CSS): the avatar's own popup is hidden there, so its
            entries ride along at the bottom of this panel. */}
        {session && (
          <div className="site-nav__account">
            <UserMenu inline />
          </div>
        )}
      </nav>

      <UserMenu loginLink />
    </header>
  );
}
