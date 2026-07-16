'use client';

import React from 'react';
import Link from 'next/link';
import UserMenu from './UserMenu';

/**
 * SpaceHeader — the shared top bar of every back-office «space» (админка,
 * конструктор): the site logo lockup linking home, the space eyebrow, an
 * optional tab strip, and the site-style user menu. One component so the
 * spaces wear the same chrome; the `ash-*` classes (app-shell header,
 * styles/admin-shell.css) are its single stylesheet.
 *
 * Desktop is a single 72px row with inline tabs; mobile hides the lockup
 * text in favor of the GEOHOD/<eyebrow> stack and moves the tabs into a
 * second row — which is why the strip renders twice (CSS shows one of them).
 */
export interface SpaceTab {
  key: string;
  label: string;
  href: string;
}

function TabStrip({
  tabs,
  active,
  variant,
  label,
}: {
  tabs: SpaceTab[];
  active?: string;
  variant: 'inline' | 'row';
  label: string;
}) {
  return (
    <nav className={`ash-tabs ash-tabs--${variant}`} aria-label={label}>
      {tabs.map((t) => (
        <Link
          key={t.key}
          href={t.href}
          className={t.key === active ? 'is-active' : undefined}
          aria-current={t.key === active ? 'page' : undefined}
        >
          {t.label}
        </Link>
      ))}
    </nav>
  );
}

export default function SpaceHeader({
  eyebrow,
  tabs,
  active,
  tabsLabel = 'Разделы',
}: {
  /** Space name shown next to the logo (and under it on mobile): «АДМИНКА»… */
  eyebrow: string;
  tabs?: SpaceTab[];
  /** `key` of the current tab. */
  active?: string;
  /** aria-label of the tab strips. */
  tabsLabel?: string;
}) {
  return (
    <header className="ash-header">
      <div className="ash-bar">
        <Link className="logo ash-logo" href="/" aria-label="GEOHOD QUEST — на главную">
          <span className="ic logo-mark" />
          <span className="ic logo-text ash-logo-text" />
          <span className="ash-logo-stack">
            <span className="ash-logo-name">GEOHOD</span>
            <span className="ash-logo-sub">{eyebrow}</span>
          </span>
        </Link>
        <span className="ash-divider" aria-hidden />
        <span className="ash-eyebrow">{eyebrow}</span>
        {tabs && <TabStrip tabs={tabs} active={active} variant="inline" label={tabsLabel} />}
        <UserMenu siteLink />
      </div>
      {tabs && <TabStrip tabs={tabs} active={active} variant="row" label={tabsLabel} />}
    </header>
  );
}
