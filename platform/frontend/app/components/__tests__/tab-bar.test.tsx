// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import React from 'react';

/**
 * §1.2 mobile bottom tab bar — shown ONLY on the top-level storefront pages
 * («Магазин» /, «Профиль»). Everywhere else (player, product page, editor,
 * admin, auth) it renders nothing, so the paper player and focused flows
 * keep the full viewport. Visibility below 768px is CSS; the pathname gate
 * is what we test here.
 */
const { pathnameRef } = vi.hoisted(() => ({ pathnameRef: { current: '/' } }));
vi.mock('next/navigation', () => ({ usePathname: () => pathnameRef.current }));

import TabBar from '../TabBar';

function renderAt(pathname: string) {
  pathnameRef.current = pathname;
  return render(<TabBar />);
}

beforeEach(() => { pathnameRef.current = '/'; });

describe('TabBar', () => {
  it.each(['/', '/profile'])('renders the two tabs on %s', (p) => {
    renderAt(p);
    expect(screen.getByRole('link', { name: 'Магазин' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Профиль' })).toBeTruthy();
  });

  it.each([
    '/quest/abc',            // player — paper system, no site chrome
    '/quest/abc/about',      // product page — back header + purchase bar instead
    '/my-quests',            // no longer a top-level tab; reached from /profile instead
    '/quest-editor',
    '/admin',
    '/auth',
  ])('renders nothing on %s', (p) => {
    const { container } = renderAt(p);
    expect(container.innerHTML).toBe('');
  });

  it('marks the current tab active', () => {
    renderAt('/profile');
    expect(screen.getByRole('link', { name: 'Профиль' }).className).toContain('is-active');
    expect(screen.getByRole('link', { name: 'Магазин' }).className).not.toContain('is-active');
  });

  // The store lives below the hero + features on `/`; the tab must land the
  // player on the quest grid (#shop), not the top of the marketing page —
  // mirroring the desktop header's «квесты» link.
  it('store tab links to the shop grid and stays active on the home route', () => {
    renderAt('/');
    const store = screen.getByRole('link', { name: 'Магазин' });
    expect(store.getAttribute('href')).toBe('/#shop');
    expect(store.className).toContain('is-active');
  });
});
