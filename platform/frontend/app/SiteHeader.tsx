'use client';

import React, { useState, useEffect } from 'react';
import Link from 'next/link';

/**
 * SiteHeader — visual + behavior port from the design site header.
 * Client state: user dropdown + (mobile) nav drawer, both click-outside close.
 *
 * Mobile: the desktop inline nav cannot fit a phone, so below 768px a
 * .nav-toggle hamburger (styled in styles/responsive.css) reveals the nav as
 * a dropdown panel. Desktop markup/layout is unchanged — the toggle is
 * display:none until the phone tier, so it stays out of the flex flow.
 */
export default function SiteHeader() {
  const [menuOpen, setMenuOpen] = useState(false);
  const [navOpen, setNavOpen] = useState(false);

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
          <Link href="/quest-editor" role="menuitem">редактор</Link>
          <Link href="/auth" role="menuitem">выход</Link>
        </div>
      </div>
    </header>
  );
}
