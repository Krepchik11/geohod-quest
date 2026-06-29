'use client';

import { useEffect } from 'react';

/**
 * Publishes the on-screen keyboard's occluded height as the CSS var `--kb-inset`
 * on <html>. iOS Safari ignores `interactiveWidget: 'resizes-content'`, so sticky
 * bars / modals near the bottom are overlaid by the keyboard. The visualViewport
 * gives the real occluded height on both platforms; Android (already resized)
 * reports ~0, so consumers that add `bottom: var(--kb-inset)` are no-ops there.
 *
 * Read-only: this only exposes a measurement (no moving bar, no scroll hijack),
 * so it carries none of the keyboard-listener fragility of a JS-driven docked bar.
 * Consumers live in app/styles/player-paper.css (scoped to .player-shell .pframe).
 */
export function useKeyboardInset(): void {
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const root = document.documentElement;
    const update = () => {
      const inset = Math.max(0, window.innerHeight - (vv.height + vv.offsetTop));
      root.style.setProperty('--kb-inset', `${Math.round(inset)}px`);
    };
    update();
    vv.addEventListener('resize', update);
    vv.addEventListener('scroll', update);
    return () => {
      vv.removeEventListener('resize', update);
      vv.removeEventListener('scroll', update);
      root.style.removeProperty('--kb-inset');
    };
  }, []);
}
