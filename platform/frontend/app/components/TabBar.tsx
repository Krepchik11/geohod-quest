'use client';

import React from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { hasAdminToken } from '../../lib/api';
import { canEditQuests, isAdmin } from '../../lib/roles';
import { useMe } from '../../lib/use-me';

/**
 * §1.2 mobile bottom tab bar — «Магазин» / «Профиль», plus the role-gated
 * site sections («Редактор», «Админка») for editors/admins: on mobile the
 * top nav is hidden, so this bar is where ALL sections live — the same rule
 * as the desktop header. Rendered from the root layout but mounts ONLY on
 * the top-level storefront pages; the player, product page, editor, admin
 * and auth keep the full viewport (the product page has its own sticky
 * purchase bar). Visibility above 768px is CSS (.tab-bar is display:none on
 * desktop).
 */
// `match` is the pathname the tab represents (visibility + active state); `href`
// is where tapping it navigates. They differ for «Магазин»: the store grid sits
// below the hero on `/`, so the tab jumps to #shop like the desktop header does.
const TABS = [
  { match: '/', href: '/#shop', label: 'Магазин', icon: 'shop' },
  { match: '/profile', href: '/profile', label: 'Профиль', icon: 'user' },
] as const;

const VISIBLE_ON = new Set(TABS.map((t) => t.match));

function TabIcon({ icon }: { icon: 'shop' | 'user' | 'edit' | 'admin' }) {
  if (icon === 'shop') {
    return (
      <span className="tab-bar__ic tab-bar__ic--shop" aria-hidden>
        <span /><span /><span /><span />
      </span>
    );
  }
  if (icon === 'edit') {
    return (
      <span className="tab-bar__ic tab-bar__ic--svg" aria-hidden>
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none"><path d="M4 20h4L19.5 8.5a2.1 2.1 0 00-3-3L5 17v3z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" /></svg>
      </span>
    );
  }
  if (icon === 'admin') {
    return (
      <span className="tab-bar__ic tab-bar__ic--svg" aria-hidden>
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none"><path d="M12 3l7 3v5c0 4.4-3 8.4-7 10-4-1.6-7-5.6-7-10V6l7-3z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" /></svg>
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
  const { role } = useMe();
  if (!VISIBLE_ON.has(pathname as (typeof TABS)[number]['match'])) return null;

  // The role-gated sections, mirroring the desktop header nav (see SiteHeader:
  // a briefly-stale link only ever reaches a clean "no access" screen).
  const tabs: Array<{ match: string; href: string; label: string; icon: React.ComponentProps<typeof TabIcon>['icon'] }> = [
    ...TABS,
  ];
  if (canEditQuests(role) || hasAdminToken()) {
    tabs.push({ match: '/quest-editor', href: '/quest-editor', label: 'Редактор', icon: 'edit' });
  }
  if (isAdmin(role) || hasAdminToken()) {
    tabs.push({ match: '/admin', href: '/admin', label: 'Админка', icon: 'admin' });
  }

  return (
    <nav className="tab-bar" aria-label="Разделы">
      {tabs.map((t) => (
        <Link key={t.match} href={t.href} className={`tab-bar__tab ${pathname === t.match ? 'is-active' : ''}`}>
          <TabIcon icon={t.icon} />
          <span>{t.label}</span>
        </Link>
      ))}
    </nav>
  );
}
