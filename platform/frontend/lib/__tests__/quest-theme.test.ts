import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  MIN_TEXT_CONTRAST,
  PAPER_THEME,
  contrastRatio,
  parseTheme,
  themeVars,
} from '../quest-theme';

const DARK = { bg: '#101014', ink: '#F2F2F5', btn: '#F2F2F5' };
const vars = (t: Parameters<typeof themeVars>[0]) => themeVars(t) as Record<string, string>;

describe('themeVars', () => {
  it('is empty without a theme — the quest keeps the defaults from CSS', () => {
    expect(themeVars(null)).toEqual({});
    expect(themeVars(undefined)).toEqual({});
  });

  it('keeps the button label readable on the button', () => {
    const onDark = vars({ ...DARK, btn: '#101014' })['--p-btn-ink'];
    const onLight = vars({ ...DARK, btn: '#F2F2F5' })['--p-btn-ink'];
    expect(contrastRatio(onDark, '#101014')).toBeGreaterThan(MIN_TEXT_CONTRAST);
    expect(contrastRatio(onLight, '#F2F2F5')).toBeGreaterThan(MIN_TEXT_CONTRAST);
  });

  it('lifts the fixed hues until they read on the author’s background', () => {
    // «Неверный ответ» and the coin caption are not the author's to choose, so
    // they must survive a background the author DID choose.
    const dark = vars(DARK);
    expect(contrastRatio(dark['--p-accent'], DARK.bg)).toBeGreaterThanOrEqual(MIN_TEXT_CONTRAST);
    expect(contrastRatio(dark['--p-coin-rim'], DARK.bg)).toBeGreaterThanOrEqual(MIN_TEXT_CONTRAST);
    // On paper they already read, so they are left exactly as designed.
    expect(vars(PAPER_THEME)['--p-accent']).toBe('#a33b2a');
  });

  it('derives the translucent tones from the author’s text colour', () => {
    expect(vars(DARK)['--p-muted']).toBe('rgba(242,242,245,0.72)');
    expect(vars(DARK)['--p-line']).toBe('rgba(242,242,245,0.28)');
  });

  it('falls back to paper for a colour it cannot read, never to nothing', () => {
    expect(vars({ bg: 'не цвет', ink: '#F2F2F5', btn: '#F2F2F5' })['--p-bg']).toBe('#fbf1e5');
  });

  it('returns the same object for the same colours — the player re-renders per keystroke', () => {
    expect(themeVars({ ...DARK })).toBe(themeVars({ ...DARK }));
    expect(themeVars(null)).toBe(themeVars(null));
  });
});

describe('parseTheme', () => {
  it('takes three readable colours and nothing else', () => {
    expect(parseTheme({ bg: '#fff', ink: '#000', btn: '#123456' })).toEqual({
      bg: '#fff',
      ink: '#000',
      btn: '#123456',
    });
    expect(parseTheme({ bg: '#fff', ink: '#000' })).toBeNull();
    expect(parseTheme({ bg: '#fff', ink: '#000', btn: 'red' })).toBeNull();
    // The hash is required — the backend's snapshot_theme requires it too, and a
    // theme the player paints but the manifest ignores is the flash we removed.
    expect(parseTheme({ bg: 'ffffff', ink: '#000', btn: '#123456' })).toBeNull();
    expect(parseTheme({ bg: 1, ink: 2, btn: 3 })).toBeNull();
    expect(parseTheme(null)).toBeNull();
    expect(parseTheme('#fff')).toBeNull();
  });
});

describe('contrastRatio', () => {
  it('matches the WCAG extremes', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 1);
    expect(contrastRatio('#123456', '#123456')).toBeCloseTo(1, 5);
  });

  it('confirms the paper palette is readable', () => {
    expect(contrastRatio(PAPER_THEME.ink, PAPER_THEME.bg)).toBeGreaterThan(MIN_TEXT_CONTRAST);
  });
});

/**
 * The paper defaults in player-paper.css are a TRANSCRIPT of
 * `themeVars(PAPER_THEME)` — same names, same values. Two consequences this pins:
 * a quest with no colours and a quest whose colours ARE the paper palette render
 * identically (so flipping «свои цвета» on changes nothing), and a token can
 * neither be declared in CSS and forgotten in the derivation (it would stay paper
 * on a themed quest) nor derived and never used.
 */
describe('the stylesheet defaults are themeVars(PAPER_THEME)', () => {
  /** `--p-*` tokens on `.pframe` that are not colours: fonts, radii, paddings,
   *  and the texture, which is a gradient over `--p-ink-faint`. */
  const NOT_A_COLOUR = new Set([
    '--p-bg-texture',
    '--p-display',
    '--p-body',
    '--p-btn-radius',
    '--p-radius',
    '--p-pad-x',
    '--p-pad-top',
  ]);

  it('declares the same tokens with the same values', () => {
    const css = readFileSync(join(process.cwd(), 'app/styles/player-paper.css'), 'utf8');
    const block = css.slice(css.indexOf('\n.pframe {'));
    const declared = new Map(
      [...block.slice(0, block.indexOf('\n}')).matchAll(/^\s*(--p-[a-z-]+):\s*([^;]+);/gm)]
        .map((m) => [m[1], m[2].trim()] as const)
        .filter(([token]) => !NOT_A_COLOUR.has(token)),
    );
    expect(Object.fromEntries(declared)).toEqual(vars(PAPER_THEME));
  });
});
