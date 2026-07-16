'use client';

import { useEffect, useRef } from 'react';

/**
 * Routes the browser/system back button into in-page navigation (the
 * `player_back_button` feature): while armed, one sentinel history entry sits
 * on top of the stack, so a back press lands on the page itself and fires
 * `popstate` instead of leaving.
 *
 * Each press calls `onBack()`:
 * - `true`  — consumed (a step/screen was rewound); the sentinel is re-pushed
 *   so the next press is trapped too.
 * - `false` — nothing left to rewind; the trap releases and `history.back()`
 *   pops the entry the sentinel replaced, so ONE press exits the page.
 *
 * The sentinel is pushed once per mount (ref-guarded: StrictMode's double
 * effect run must not stack two). It is not popped on unmount — a same-URL
 * orphan entry is the trap pattern's known cost, harmless beyond one extra
 * back press after returning through history.
 */
export function useHistoryBackTrap(enabled: boolean, onBack: () => boolean) {
  // Always call the latest callback — step state changes every advance and a
  // stale closure would rewind to the wrong step.
  const onBackRef = useRef(onBack);
  useEffect(() => {
    onBackRef.current = onBack;
  });

  const armedRef = useRef(false);
  useEffect(() => {
    if (!enabled || armedRef.current) return;
    armedRef.current = true;
    window.history.pushState({ gqBackTrap: true }, '');
    const onPop = () => {
      if (onBackRef.current()) {
        window.history.pushState({ gqBackTrap: true }, '');
      } else {
        window.removeEventListener('popstate', onPop);
        window.history.back();
      }
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, [enabled]);
}
