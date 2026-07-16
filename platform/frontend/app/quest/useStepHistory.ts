'use client';

import { useCallback, useEffect, useMemo, useRef } from 'react';

/**
 * System/browser back rewinds quest steps (the `player_back_button` feature) —
 * entries-mirror-steps design.
 *
 * Every user-driven advance PUSHES a real history entry `{gqStep: to}` (and
 * heals the entry being left with `replaceState({gqStep: from})`, since
 * hydration/resume can move the view without any history write). A back press
 * then traverses a genuine, gesture-created entry: nothing is pushed during
 * the press itself, so consecutive presses rewind step by step all the way to
 * step 0 and one further press leaves the page. This is what the previous
 * sentinel-trap design could not do — its re-pushed sentinel was created
 * inside `popstate` without user activation, which Chromium's history
 * manipulation intervention marks skippable, killing the trap after one press.
 *
 * `popstate` routing:
 * - entry has `gqStep` → intra-quest traversal; the view follows the entry
 *   (back rewinds, forward redoes — the fact log is append-only and every
 *   completion side effect is idempotency-guarded, so re-advancing is safe);
 * - an open overlay eats the press instead: close it and undo the traversal
 *   (`forward()`/`back()` — a script traversal, no activation involved);
 * - no `gqStep` → the browser is leaving the quest; never interfere.
 *
 * Leave guard (Navigation API, feature-detected): a BACKWARD traversal that
 * would exit the quest mid-run (resumed attempts have no step entries below
 * the current one) is canceled and converted into one rewind/overlay close.
 * The platform intentionally consumes the user activation on each such
 * cancel (WICG navigation-api: «preventDefault() on a traversal consumes the
 * user activation, ensuring that the user can always break out»), so this
 * buys exactly ONE press per user interaction — a fully trapped resume rewind
 * is impossible by spec in every browser, and when the event arrives
 * non-cancelable the exit must proceed.
 *
 * States are plain `{gqStep}` objects: Next's patched pushState/replaceState
 * re-injects its internal route state itself (its own docs pass `null`).
 */
interface StepHistoryCallbacks {
  /** Current view step index — the leave guard rewinds from here. */
  stepIdx: number;
  /** popstate/guard-driven view move; the caller clamps to its own bounds. */
  onGoToStep: (idx: number) => void;
  isOverlayOpen: () => boolean;
  onCloseOverlay: () => void;
}

export function useStepHistory(
  enabled: boolean,
  cbs: StepHistoryCallbacks
): { advance: (from: number, to: number) => void } {
  // Always read the latest callbacks/state — step state changes every advance
  // and a stale closure would rewind to the wrong step.
  const cbsRef = useRef(cbs);
  useEffect(() => {
    cbsRef.current = cbs;
  });

  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;

  const advance = useCallback((from: number, to: number) => {
    if (!enabledRef.current) return;
    window.history.replaceState({ gqStep: from }, '');
    window.history.pushState({ gqStep: to }, '');
  }, []);

  useEffect(() => {
    if (!enabled) return;

    const onPop = (e: PopStateEvent) => {
      const step = (e.state as { gqStep?: unknown } | null)?.gqStep;
      if (typeof step !== 'number') return;
      const view = cbsRef.current.stepIdx;
      if (cbsRef.current.isOverlayOpen()) {
        cbsRef.current.onCloseOverlay();
        // Undo the traversal so the press only closed the overlay. When the
        // entry already matches the view (post-divergence heal) there is
        // nothing to undo.
        if (step < view) window.history.forward();
        else if (step > view) window.history.back();
        return;
      }
      cbsRef.current.onGoToStep(step);
    };
    window.addEventListener('popstate', onPop);

    const nav = (window as { navigation?: EventTarget & { currentEntry?: { index?: number } } })
      .navigation;
    const onNavigate = (e: Event) => {
      const ev = e as Event & {
        navigationType?: string;
        destination?: { url: string; index?: number };
      };
      if (ev.navigationType !== 'traverse' || !ev.cancelable || !ev.destination) return;
      // Never trap forward traversals — only back presses are converted.
      const cur = nav?.currentEntry?.index;
      if (
        typeof cur === 'number' &&
        typeof ev.destination.index === 'number' &&
        ev.destination.index >= cur
      ) {
        return;
      }
      let leaving = false;
      try {
        leaving = new URL(ev.destination.url).pathname !== window.location.pathname;
      } catch {
        return;
      }
      if (!leaving) return;
      if (cbsRef.current.isOverlayOpen()) {
        e.preventDefault();
        cbsRef.current.onCloseOverlay();
        return;
      }
      if (cbsRef.current.stepIdx > 0) {
        e.preventDefault();
        cbsRef.current.onGoToStep(cbsRef.current.stepIdx - 1);
      }
    };
    nav?.addEventListener('navigate', onNavigate);

    return () => {
      window.removeEventListener('popstate', onPop);
      nav?.removeEventListener('navigate', onNavigate);
    };
  }, [enabled]);

  return useMemo(() => ({ advance }), [advance]);
}
