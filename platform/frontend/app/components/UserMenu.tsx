'use client';

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { logoutAndReset } from '../../lib/session-actions';
import { roleWord } from '../../lib/roles';
import { useMe } from '../../lib/use-me';

/**
 * THE profile button + dropdown — one component for every surface (storefront
 * header, admin shell, constructor dashboard) so the control always has the
 * same look and the same behavior: avatar button with the presence dot, a
 * dropdown with the account head (name · role), «мой профиль», an optional
 * «на сайт» (for the admin/constructor surfaces that live outside the main
 * site chrome) and a REAL «выйти» (clears the session and rotates the device
 * id — lib/session-actions).
 *
 * Section navigation (админка / редактор) deliberately does NOT live here —
 * those are site sections and belong to the top nav / tab bar, next to the
 * other sections.
 *
 * Anonymous callers: with `loginLink` the slot renders the «Войти» pill
 * (storefront §2.5 — never a bare icon button for anonymous visitors);
 * without it the menu still renders minus «выйти» (an operator build without
 * a session keeps «на сайт» reachable — the admin shell case).
 */
export default function UserMenu({
  siteLink = false,
  loginLink = false,
}: {
  /** Add «на сайт» — for surfaces outside the main site chrome. */
  siteLink?: boolean;
  /** Anonymous visitors get the «Войти» pill instead of the menu. */
  loginLink?: boolean;
}) {
  const { session, role, displayName } = useMe();
  const [open, setOpen] = useState(false);

  // Click-outside closes the dropdown.
  useEffect(() => {
    if (!open) return;
    const onDoc = () => setOpen(false);
    document.addEventListener('click', onDoc);
    return () => document.removeEventListener('click', onDoc);
  }, [open]);

  if (!session && loginLink) {
    return <Link className="header-login" href="/auth">Войти</Link>;
  }

  const handleLogout = () => {
    setOpen(false);
    // Flush pending facts, clear the session + rotate the device id (un-bricks
    // anonymous use), and wipe local play — then full-navigate home so every
    // island re-reads the fresh anonymous identity.
    void logoutAndReset().finally(() => {
      window.location.href = '/';
    });
  };

  const headName = displayName ?? session?.email ?? null;

  return (
    <div className={`user-menu ${open ? 'is-open' : ''}`}>
      <button
        className="user-menu__btn"
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        title="Профиль"
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
      >
        <span className="user-icon">
          <span className="head" />
          <span className="body" />
        </span>
        {session && <span className="user-menu__dot" aria-hidden />}
      </button>
      <div className="user-menu__dropdown" role="menu">
        {session && headName && (
          <div className="user-menu__head">
            <div className="user-menu__name">{headName}</div>
            <div className="user-menu__role">{roleWord(role)}</div>
          </div>
        )}
        <Link href="/profile" role="menuitem">мой профиль</Link>
        {siteLink && <Link href="/" role="menuitem">на сайт</Link>}
        {session && (
          <button type="button" role="menuitem" onClick={handleLogout}>выйти</button>
        )}
      </div>
    </div>
  );
}
