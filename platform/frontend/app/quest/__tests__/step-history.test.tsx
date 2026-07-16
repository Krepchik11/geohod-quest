// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { act } from 'react';
import { useStepHistory } from '../useStepHistory';

/**
 * useStepHistory — the player_back_button behavior, entries-mirror-steps
 * design: every user-driven advance pushes a real (gesture-backed) history
 * entry `{gqStep}`, so consecutive system-back presses traverse real entries —
 * nothing is re-pushed during a back press, which is what Chromium's history
 * manipulation intervention would mark skippable.
 *
 * popstate with a `gqStep` entry = intra-quest traversal → view follows the
 * entry (back rewinds, forward redoes). An open overlay eats the press
 * instead: close + undo the traversal. popstate without `gqStep` = the
 * browser is leaving the quest — untouched.
 *
 * The navigate-event leave guard (Navigation API, feature-detected) converts
 * a BACKWARD traversal that would exit mid-quest into one rewind or overlay
 * close, when the event is cancelable.
 */
let pushSpy: ReturnType<typeof vi.spyOn>;
let replaceSpy: ReturnType<typeof vi.spyOn>;
let forwardSpy: ReturnType<typeof vi.spyOn>;
let backSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  pushSpy = vi.spyOn(window.history, 'pushState');
  replaceSpy = vi.spyOn(window.history, 'replaceState');
  forwardSpy = vi.spyOn(window.history, 'forward').mockImplementation(() => {});
  backSpy = vi.spyOn(window.history, 'back').mockImplementation(() => {});
});

afterEach(() => {
  pushSpy.mockRestore();
  replaceSpy.mockRestore();
  forwardSpy.mockRestore();
  backSpy.mockRestore();
  delete (window as { navigation?: unknown }).navigation;
});

function popTo(state: unknown) {
  act(() => {
    window.dispatchEvent(new PopStateEvent('popstate', { state }));
  });
}

function setup(enabled: boolean, stepIdx = 0) {
  const onGoToStep = vi.fn();
  const isOverlayOpen = vi.fn(() => false);
  const onCloseOverlay = vi.fn();
  const utils = renderHook(
    ({ en, idx }: { en: boolean; idx: number }) =>
      useStepHistory(en, { stepIdx: idx, onGoToStep, isOverlayOpen, onCloseOverlay }),
    { initialProps: { en: enabled, idx: stepIdx } }
  );
  return { onGoToStep, isOverlayOpen, onCloseOverlay, ...utils };
}

describe('useStepHistory', () => {
  it('disabled: advance() writes nothing, popstate is ignored', () => {
    const { result, onGoToStep } = setup(false);
    act(() => result.current.advance(0, 1));
    expect(pushSpy).not.toHaveBeenCalled();
    expect(replaceSpy).not.toHaveBeenCalled();
    popTo({ gqStep: 3 });
    expect(onGoToStep).not.toHaveBeenCalled();
  });

  it('advance(from, to): heals the left entry, then pushes the new step entry', () => {
    const { result } = setup(true, 4);
    act(() => result.current.advance(4, 5));
    expect(replaceSpy).toHaveBeenCalledWith({ gqStep: 4 }, '');
    expect(pushSpy).toHaveBeenCalledWith({ gqStep: 5 }, '');
  });

  it('popstate to a step entry moves the view there (back AND forward)', () => {
    const { onGoToStep } = setup(true, 5);
    popTo({ gqStep: 4 });
    expect(onGoToStep).toHaveBeenCalledWith(4);
    popTo({ gqStep: 6 });
    expect(onGoToStep).toHaveBeenCalledWith(6);
  });

  it('popstate without gqStep (leaving the quest) is left to the browser', () => {
    const { onGoToStep, onCloseOverlay } = setup(true, 5);
    popTo(null);
    popTo({ something: 'else' });
    expect(onGoToStep).not.toHaveBeenCalled();
    expect(onCloseOverlay).not.toHaveBeenCalled();
    expect(forwardSpy).not.toHaveBeenCalled();
  });

  it('open overlay eats the press: close + undo the BACK traversal via forward()', () => {
    const { onGoToStep, isOverlayOpen, onCloseOverlay } = setup(true, 5);
    isOverlayOpen.mockReturnValue(true);
    popTo({ gqStep: 4 });
    expect(onCloseOverlay).toHaveBeenCalledTimes(1);
    expect(onGoToStep).not.toHaveBeenCalled();
    expect(forwardSpy).toHaveBeenCalledTimes(1);
    expect(backSpy).not.toHaveBeenCalled();
  });

  it('open overlay + FORWARD traversal: close + undo via back()', () => {
    const { isOverlayOpen, onCloseOverlay } = setup(true, 5);
    isOverlayOpen.mockReturnValue(true);
    popTo({ gqStep: 6 });
    expect(onCloseOverlay).toHaveBeenCalledTimes(1);
    expect(backSpy).toHaveBeenCalledTimes(1);
    expect(forwardSpy).not.toHaveBeenCalled();
  });

  it('open overlay + traversal to the CURRENT step index: close only, no undo', () => {
    const { isOverlayOpen, onCloseOverlay } = setup(true, 5);
    isOverlayOpen.mockReturnValue(true);
    popTo({ gqStep: 5 });
    expect(onCloseOverlay).toHaveBeenCalledTimes(1);
    expect(forwardSpy).not.toHaveBeenCalled();
    expect(backSpy).not.toHaveBeenCalled();
  });

  it('always uses the LATEST callbacks (no stale closure over step state)', () => {
    const first = vi.fn();
    const second = vi.fn();
    const { rerender } = renderHook(
      ({ cb }: { cb: (idx: number) => void }) =>
        useStepHistory(true, {
          stepIdx: 5,
          onGoToStep: cb,
          isOverlayOpen: () => false,
          onCloseOverlay: () => {},
        }),
      { initialProps: { cb: first } }
    );
    rerender({ cb: second });
    popTo({ gqStep: 4 });
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledWith(4);
  });

  it('unmount removes the popstate listener', () => {
    const { onGoToStep, unmount } = setup(true, 5);
    unmount();
    popTo({ gqStep: 4 });
    expect(onGoToStep).not.toHaveBeenCalled();
  });

  describe('leave guard (Navigation API)', () => {
    function installNavigation(currentIndex = 1) {
      const nav = new EventTarget() as EventTarget & { currentEntry?: { index: number } };
      nav.currentEntry = { index: currentIndex };
      (window as { navigation?: unknown }).navigation = nav;
      return nav;
    }

    function traverse(
      nav: EventTarget,
      { url = 'http://localhost/other', index = 0, cancelable = true, type = 'traverse' } = {}
    ) {
      const e = new Event('navigate', { cancelable });
      Object.assign(e, { navigationType: type, destination: { url, index } });
      act(() => {
        nav.dispatchEvent(e);
      });
      return e;
    }

    it('backward traversal leaving the quest mid-run: canceled, one step rewound', () => {
      const nav = installNavigation();
      const { onGoToStep } = setup(true, 5);
      const e = traverse(nav);
      expect(e.defaultPrevented).toBe(true);
      expect(onGoToStep).toHaveBeenCalledWith(4);
    });

    it('with an overlay open: canceled, overlay closed, no rewind', () => {
      const nav = installNavigation();
      const { onGoToStep, isOverlayOpen, onCloseOverlay } = setup(true, 5);
      isOverlayOpen.mockReturnValue(true);
      const e = traverse(nav);
      expect(e.defaultPrevented).toBe(true);
      expect(onCloseOverlay).toHaveBeenCalledTimes(1);
      expect(onGoToStep).not.toHaveBeenCalled();
    });

    it('at step 0 with no overlay: the exit proceeds', () => {
      const nav = installNavigation();
      const { onGoToStep } = setup(true, 0);
      const e = traverse(nav);
      expect(e.defaultPrevented).toBe(false);
      expect(onGoToStep).not.toHaveBeenCalled();
    });

    it('same-path traversal (our own step entries): untouched', () => {
      const nav = installNavigation();
      const { onGoToStep } = setup(true, 5);
      const e = traverse(nav, { url: 'http://localhost/' });
      expect(e.defaultPrevented).toBe(false);
      expect(onGoToStep).not.toHaveBeenCalled();
    });

    it('FORWARD traversal leaving the quest: untouched (never trap forward)', () => {
      const nav = installNavigation(1);
      const { onGoToStep } = setup(true, 5);
      const e = traverse(nav, { index: 2 });
      expect(e.defaultPrevented).toBe(false);
      expect(onGoToStep).not.toHaveBeenCalled();
    });

    it('non-cancelable event (activation already consumed): no rewind, browser wins', () => {
      const nav = installNavigation();
      const { onGoToStep } = setup(true, 5);
      const e = traverse(nav, { cancelable: false });
      expect(e.defaultPrevented).toBe(false);
      expect(onGoToStep).not.toHaveBeenCalled();
    });

    it('non-traverse navigations (router.push etc.): untouched', () => {
      const nav = installNavigation();
      const { onGoToStep } = setup(true, 5);
      const e = traverse(nav, { type: 'push' });
      expect(e.defaultPrevented).toBe(false);
      expect(onGoToStep).not.toHaveBeenCalled();
    });
  });
});
