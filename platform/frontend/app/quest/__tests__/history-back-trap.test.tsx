// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { act } from 'react';
import { useHistoryBackTrap } from '../useHistoryBackTrap';

/**
 * useHistoryBackTrap — the player_back_button behavior: while armed, a
 * browser/system back press calls `onBack()`; `true` = consumed (trap
 * re-arms), `false` = the navigation is handed back to the browser.
 */
let pushSpy: ReturnType<typeof vi.spyOn>;
let backSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  pushSpy = vi.spyOn(window.history, 'pushState');
  backSpy = vi.spyOn(window.history, 'back').mockImplementation(() => {});
});

afterEach(() => {
  pushSpy.mockRestore();
  backSpy.mockRestore();
});

function pressBack() {
  act(() => {
    window.dispatchEvent(new PopStateEvent('popstate'));
  });
}

describe('useHistoryBackTrap', () => {
  it('disabled: never touches history, back presses pass through', () => {
    const onBack = vi.fn(() => true);
    renderHook(() => useHistoryBackTrap(false, onBack));
    pressBack();
    expect(pushSpy).not.toHaveBeenCalled();
    expect(onBack).not.toHaveBeenCalled();
  });

  it('enabled: arms exactly once, even across a re-render', () => {
    const onBack = vi.fn(() => true);
    const { rerender } = renderHook(() => useHistoryBackTrap(true, onBack));
    rerender();
    expect(pushSpy).toHaveBeenCalledTimes(1);
  });

  it('consumed back press (onBack → true) re-arms the trap', () => {
    const onBack = vi.fn(() => true);
    renderHook(() => useHistoryBackTrap(true, onBack));
    pressBack();
    expect(onBack).toHaveBeenCalledTimes(1);
    expect(pushSpy).toHaveBeenCalledTimes(2); // arm + re-arm
    expect(backSpy).not.toHaveBeenCalled();
  });

  it('unconsumed back press (onBack → false) releases: history.back(), no re-arm, trap dead', () => {
    const onBack = vi.fn(() => false);
    renderHook(() => useHistoryBackTrap(true, onBack));
    pressBack();
    expect(backSpy).toHaveBeenCalledTimes(1);
    expect(pushSpy).toHaveBeenCalledTimes(1); // only the initial arm
    pressBack(); // trap released — no further onBack calls
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it('always calls the LATEST onBack (no stale closure over step state)', () => {
    const first = vi.fn(() => true);
    const second = vi.fn(() => true);
    const { rerender } = renderHook(({ cb }) => useHistoryBackTrap(true, cb), {
      initialProps: { cb: first },
    });
    rerender({ cb: second });
    pressBack();
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('arming waits for enabled to turn true (async flag fetch)', () => {
    const onBack = vi.fn(() => true);
    const { rerender } = renderHook(({ on }) => useHistoryBackTrap(on, onBack), {
      initialProps: { on: false },
    });
    expect(pushSpy).not.toHaveBeenCalled();
    rerender({ on: true });
    expect(pushSpy).toHaveBeenCalledTimes(1);
    pressBack();
    expect(onBack).toHaveBeenCalledTimes(1);
  });
});
