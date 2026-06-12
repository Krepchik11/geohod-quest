'use client';

import React, { useState, useEffect } from 'react';
import Link from 'next/link';

/**
 * AdminHeader — port of design admin-header + user dropdown + nav (from js/admin.js + admin.css).
 * Narrow client only for dropdown toggle + outside click.
 * Real screens per handoff: Квесты (cabinet), Стат., Пользователи, Галерея.
 * Others stubs (opacity, preventDefault).
 * Per react.md + KISS: small, explicit, no inner comp defs.
 */
export default function AdminHeader({ active = 'kvesty' }: { active?: string }) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    document.addEventListener('click', close);
    return () => document.removeEventListener('click', close);
  }, [open]);

  const nav = [
    ['kvesty', 'Квесты', '/cabinet'],
    ['stat', 'Стат.', '/admin/stats'],
    ['polzovateli', 'Пользователи', '/admin/users'],
    ['galereya', 'Галерея', '/admin/gallery'],
  ] as const;

  return (
    <header className="admin-header">
      <Link className="brand-foot" href="/" title="GEOHOD — на сайт" aria-label="На сайт">
        <span className="a" /><span className="b" /><span className="c" /><span className="d" />
      </Link>
      <nav className="admin-nav" aria-label="Разделы админки">
        {nav.map(([id, label, href]) => (
          <a key={id} href={href} className={id === active ? 'is-active' : ''}>{label}</a>
        ))}
      </nav>
      <div className={`admin-user ${open ? 'is-open' : ''}`}>
        <button
          className="admin-user__btn"
          type="button"
          aria-haspopup="menu"
          aria-expanded={open}
          onClick={(e) => { e.stopPropagation(); setOpen(v => !v); }}
        >
          <span className="user-icon" style={{ position: 'relative', width: 24, height: 24 }}>
            <span className="head" style={{ position: 'absolute', left: '33%', top: '8%', width: '34%', height: '38%', background: "url('/assets/icons/c/ic-user-head--dark.svg') no-repeat center/contain" }} />
            <span className="body" style={{ position: 'absolute', left: '17%', top: '56%', width: '66%', height: '36%', background: "url('/assets/icons/c/ic-user-body--dark.svg') no-repeat center/contain" }} />
          </span>
        </button>
        <div className="admin-user__dropdown" role="menu">
          <a href="/auth" role="menuitem">Выход</a>
        </div>
      </div>
    </header>
  );
}
