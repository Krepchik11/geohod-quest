'use client';

import React, { useState, useEffect } from 'react';
import Link from 'next/link';

/**
 * SiteHeader — visual + behavior port from the design site header.
 * Narrow client state only for the user dropdown (click-outside close).
 */
export default function SiteHeader() {
  const [menuOpen, setMenuOpen] = useState(false);

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
