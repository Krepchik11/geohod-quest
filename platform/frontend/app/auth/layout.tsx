import React from 'react';
import SiteShell from '../components/SiteShell';

/**
 * The auth surface (§2.5): every /auth screen — sign-in, confirm, reset — is
 * one centered card on the subtle background with no storefront footer. The
 * route layout states that once; the pages render only their card.
 */
export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <SiteShell variant="auth">
      <div className="auth-wrap">{children}</div>
    </SiteShell>
  );
}
