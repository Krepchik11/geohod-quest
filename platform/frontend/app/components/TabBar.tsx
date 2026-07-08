'use client';

import React from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

/**
 * §1.2 mobile bottom tab bar — «Магазин» / «Мои квесты» / «Профиль».
 * Rendered from the root layout but mounts ONLY on the three top-level
 * storefront pages; the player, product page, editor, admin and auth keep the
 * full viewport (the product page has its own sticky purchase bar). Visibility
 * above 768px is CSS (.tab-bar is display:none on desktop).
 */
// `match` is the pathname the tab represents (visibility + active state); `href`
// is where tapping it navigates. They differ for «Магазин»: the store grid sits
// below the hero on `/`, so the tab jumps to #shop like the desktop header does.
const TABS = [
  { match: '/', href: '/#shop', label: 'Магазин', icon: 'shop' },
  { match: '/my-quests', href: '/my-quests', label: 'Мои квесты', icon: 'list' },
  { match: '/profile', href: '/profile', label: 'Профиль', icon: 'user' },
] as const;

const VISIBLE_ON = new Set(TABS.map((t) => t.match));

function TabIcon({ icon }: { icon: 'shop' | 'list' | 'user' }) {
  if (icon === 'shop') {
    return (
      <span className="tab-bar__ic tab-bar__ic--shop" aria-hidden>
        <span /><span /><span /><span />
      </span>
    );
  }
  if (icon === 'list') {
    return (
      <span className="tab-bar__ic tab-bar__ic--list" aria-hidden>
        <span /><span /><span />
      </span>
    );
  }
  return (
    <span className="tab-bar__ic tab-bar__ic--user" aria-hidden>
      <span /><span />
    </span>
  );
}

export default function TabBar() {
  const pathname = usePathname();
  if (!VISIBLE_ON.has(pathname as (typeof TABS)[number]['match'])) return null;
  return (
    <nav className="tab-bar" aria-label="Разделы">
      {TABS.map((t) => (
        <Link key={t.match} href={t.href} className={`tab-bar__tab ${pathname === t.match ? 'is-active' : ''}`}>
          <TabIcon icon={t.icon} />
          <span>{t.label}</span>
        </Link>
      ))}
    </nav>
  );
}
