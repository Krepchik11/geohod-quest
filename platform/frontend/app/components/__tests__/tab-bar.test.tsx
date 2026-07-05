// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import React from 'react';

/**
 * §1.2 mobile bottom tab bar — shown ONLY on the three top-level storefront
 * pages («Магазин» /, «Мои квесты», «Профиль»). Everywhere else (player,
 * product page, editor, admin, auth) it renders nothing, so the paper player
 * and focused flows keep the full viewport. Visibility below 768px is CSS;
 * the pathname gate is what we test here.
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
  it.each(['/', '/my-quests', '/profile'])('renders the three tabs on %s', (p) => {
    renderAt(p);
    expect(screen.getByRole('link', { name: 'Магазин' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Мои квесты' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Профиль' })).toBeTruthy();
  });

  it.each([
    '/quest/abc',            // player — paper system, no site chrome
    '/quest/abc/about',      // product page — back header + purchase bar instead
    '/quest-editor',
    '/admin',
    '/auth',
  ])('renders nothing on %s', (p) => {
    const { container } = renderAt(p);
    expect(container.innerHTML).toBe('');
  });

  it('marks the current tab active', () => {
    renderAt('/my-quests');
    expect(screen.getByRole('link', { name: 'Мои квесты' }).className).toContain('is-active');
    expect(screen.getByRole('link', { name: 'Магазин' }).className).not.toContain('is-active');
  });
});
