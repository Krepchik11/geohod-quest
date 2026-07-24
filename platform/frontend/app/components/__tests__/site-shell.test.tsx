// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import React from 'react';

/**
 * SiteShell — the ONE public-page wrapper (.site: header + content + footer;
 * variant="auth" swaps in the footer-less subtle-background auth look),
 * replacing the per-page copies with their divergent inline styles.
 */
vi.mock('../../../lib/api', async () => (await import('./chrome-mocks')).apiMock);
vi.mock('../../../lib/identity', async () => (await import('./chrome-mocks')).identityMock);
vi.mock('../../../lib/session-actions', async () => (await import('./chrome-mocks')).sessionActionsMock);

import SiteShell from '../SiteShell';

describe('SiteShell', () => {
  it('renders header, children and footer inside the .site wrapper', () => {
    const { container } = render(
      <SiteShell>
        <main>content-here</main>
      </SiteShell>,
    );
    expect(container.firstElementChild?.className).toBe('site');
    expect(container.querySelector('.site-header')).toBeTruthy();
    expect(screen.getByText('content-here')).toBeTruthy();
    expect(container.querySelector('.site-footer')).toBeTruthy();
  });

  it('variant="auth": subtle background, no storefront footer', () => {
    const { container } = render(
      <SiteShell variant="auth">
        <div>auth</div>
      </SiteShell>,
    );
    expect(container.firstElementChild?.className).toBe('site site--subtle');
    expect(container.querySelector('.site-footer')).toBeNull();
  });
});
