/**
 * Back navigation contract — the player must be able to step BACK through the
 * quest to reread earlier content on every page:
 * - TopBar grows an optional back button (rendered only when a handler is wired,
 *   so step 0 and the constructor previews stay unchanged);
 * - the chromeless final and catalog screens (no TopBar by design) get a floating
 *   .p-backfab with the same affordance.
 *
 * react-dom/server markup assertions (matches answer-input.test.ts) — no DOM env.
 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { TopBar, FinalScreen, CatalogScreen } from '../../app/player/PlayerComponents';
import { PLAYER_COPY } from '../player-copy';

describe('TopBar back button', () => {
  it('renders an accessible back button when onBack is wired', () => {
    const html = renderToStaticMarkup(
      createElement(TopBar, { pos: 3, total: 7, coins: 5, onBack: () => {} })
    );
    expect(html).toContain('aria-label="Назад"');
  });

  it('renders no back button without a handler (step 0, editor previews)', () => {
    const html = renderToStaticMarkup(
      createElement(TopBar, { pos: 1, total: 7, coins: 5 })
    );
    expect(html).not.toContain('aria-label="Назад"');
  });
});

describe('final screen back button', () => {
  it('shows the floating back button when a back handler is wired', () => {
    const html = renderToStaticMarkup(
      createElement(FinalScreen, { copy: PLAYER_COPY, st: {}, on: { back: () => {} } })
    );
    expect(html).toContain('p-backfab');
    expect(html).toContain('aria-label="Назад"');
  });

  it('stays chromeless without a handler (previews pass none)', () => {
    const html = renderToStaticMarkup(
      createElement(FinalScreen, { copy: PLAYER_COPY, st: {}, on: {} })
    );
    expect(html).not.toContain('p-backfab');
  });
});

describe('catalog screen back button', () => {
  it('shows the floating back button when a back handler is wired', () => {
    const html = renderToStaticMarkup(
      createElement(CatalogScreen, { quests: [], copy: PLAYER_COPY, on: { back: () => {} } })
    );
    expect(html).toContain('p-backfab');
    expect(html).toContain('aria-label="Назад"');
  });

  it('renders no back button without a handler', () => {
    const html = renderToStaticMarkup(
      createElement(CatalogScreen, { quests: [], copy: PLAYER_COPY, on: {} })
    );
    expect(html).not.toContain('p-backfab');
  });
});
