import React from 'react';
import SiteHeader from '../SiteHeader';
import SiteFooter from './SiteFooter';

/**
 * SiteShell — the ONE wrapper for every public storefront page: the `.site`
 * flex column (globals.css BASE) with the shared header on top and the shared
 * footer at the bottom. Pages supply only their content, so all of them wear
 * identical chrome instead of per-page copies with divergent inline styles.
 *
 * `variant="auth"` is the §2.5 auth-screen look — --bg-subtle background and
 * no storefront footer under the card (used by app/auth/layout.tsx).
 */
export default function SiteShell({
  children,
  variant,
}: {
  children: React.ReactNode;
  variant?: 'auth';
}) {
  const auth = variant === 'auth';
  return (
    <div className={auth ? 'site site--subtle' : 'site'}>
      <SiteHeader />
      {children}
      {!auth && <SiteFooter />}
    </div>
  );
}
