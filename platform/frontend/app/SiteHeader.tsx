'use client';

import React from 'react';
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
 * Mobile (<768px): the inline nav is hidden — navigation moves to the bottom
 * tab bar (components/TabBar), which carries the same role-gated sections.
 */
export default function SiteHeader() {
  const { role } = useMe();

  return (
    <header className="site-header container">
      <Link className="logo" href="/" aria-label="GEOHOD QUEST — на главную">
        <span className="ic logo-mark" />
        <span className="ic logo-text" />
      </Link>

      <nav className="site-nav" aria-label="Основная навигация">
        <Link href="/">главная</Link>
        <Link href="/#shop">магазин квестов</Link>
        {/* §1.3: absolute anchor so «контакты» works from every page, not just /. */}
        <Link href="/#contacts">контакты</Link>
        {(canEditQuests(role) || hasAdminToken()) && (
          <Link href="/quest-editor">редактор</Link>
        )}
        {(isAdmin(role) || hasAdminToken()) && (
          <Link href="/admin">админка</Link>
        )}
      </nav>

      <UserMenu loginLink />
    </header>
  );
}
