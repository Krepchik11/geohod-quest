// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';

/**
 * useClientFeature / useUniversalAnswer — the player runtime's view of
 * GET /api/features (`{ flags, universal_answer }`). Fail-closed: a flag is
 * `false` and the universal answer `null` until the fetch resolves, for
 * unknown keys, and when the server is unreachable.
 */
const { apiMock } = vi.hoisted(() => ({
  apiMock: { getPublicFeatures: vi.fn() },
}));
vi.mock('../api', () => ({ api: apiMock }));

beforeEach(() => {
  vi.resetModules();
  apiMock.getPublicFeatures.mockReset();
});

async function loadModule() {
  return import('../client-features');
}

const wire = (flags: Record<string, boolean>, universal: string | null = null) => ({
  flags,
  universal_answer: universal,
});

describe('useClientFeature', () => {
  it('serves the fetched verdict; false before it resolves', async () => {
    apiMock.getPublicFeatures.mockResolvedValue(wire({ player_back_button: true }));
    const { useClientFeature } = await loadModule();
    const { result } = renderHook(() => useClientFeature('player_back_button'));
    expect(result.current).toBe(false); // fail-closed until loaded
    await waitFor(() => expect(result.current).toBe(true));
  });

  it('unknown keys are false even after load', async () => {
    apiMock.getPublicFeatures.mockResolvedValue(wire({ player_back_button: true }));
    const { useClientFeature } = await loadModule();
    // The type now forbids unknown keys in product code; the cast keeps the
    // runtime fail-closed rule pinned for a wire/build mismatch.
    const { result } = renderHook(() =>
      useClientFeature('no_such_flag' as Parameters<typeof useClientFeature>[0]),
    );
    await waitFor(() => expect(apiMock.getPublicFeatures).toHaveBeenCalled());
    expect(result.current).toBe(false);
  });

  it('one fetch serves every consumer (module-level cache)', async () => {
    apiMock.getPublicFeatures.mockResolvedValue(wire({ player_back_button: true }));
    const { useClientFeature } = await loadModule();
    const a = renderHook(() => useClientFeature('player_back_button'));
    const b = renderHook(() => useClientFeature('player_back_button'));
    await waitFor(() => expect(a.result.current).toBe(true));
    await waitFor(() => expect(b.result.current).toBe(true));
    expect(apiMock.getPublicFeatures).toHaveBeenCalledTimes(1);
  });

  it('a failed fetch stays false and is not cached (next mount retries)', async () => {
    apiMock.getPublicFeatures.mockRejectedValueOnce(new Error('offline'));
    const { useClientFeature } = await loadModule();
    const first = renderHook(() => useClientFeature('player_back_button'));
    await waitFor(() => expect(apiMock.getPublicFeatures).toHaveBeenCalledTimes(1));
    expect(first.result.current).toBe(false);
    first.unmount();

    apiMock.getPublicFeatures.mockResolvedValue(wire({ player_back_button: true }));
    const second = renderHook(() => useClientFeature('player_back_button'));
    await waitFor(() => expect(second.result.current).toBe(true));
  });
});

describe('useRememberedClientFeature', () => {
  beforeEach(() => window.localStorage.clear());

  it('a device that never saw the flag behaves like useClientFeature', async () => {
    apiMock.getPublicFeatures.mockResolvedValue(wire({ store_my_quests: true }));
    const { useRememberedClientFeature } = await loadModule();
    const { result } = renderHook(() => useRememberedClientFeature('store_my_quests'));
    expect(result.current).toBe(false);
    await waitFor(() => expect(result.current).toBe(true));
  });

  it('serves the last verdict this device saw while offline', async () => {
    apiMock.getPublicFeatures.mockResolvedValue(wire({ store_my_quests: true }));
    const online = await loadModule();
    const seen = renderHook(() => online.useRememberedClientFeature('store_my_quests'));
    await waitFor(() => expect(seen.result.current).toBe(true));
    seen.unmount();

    // Next page load, airplane mode: the fetch fails, the memory answers.
    vi.resetModules();
    apiMock.getPublicFeatures.mockRejectedValue(new Error('offline'));
    const offline = await loadModule();
    const { result } = renderHook(() => offline.useRememberedClientFeature('store_my_quests'));
    await waitFor(() => expect(apiMock.getPublicFeatures).toHaveBeenCalledTimes(2));
    expect(result.current).toBe(true);
  });

  it('the fetched verdict wins over the remembered one', async () => {
    window.localStorage.setItem('geohod-flags:v1', JSON.stringify({ store_my_quests: true }));
    apiMock.getPublicFeatures.mockResolvedValue(wire({ store_my_quests: false }));
    const { useRememberedClientFeature } = await loadModule();
    const { result } = renderHook(() => useRememberedClientFeature('store_my_quests'));
    expect(result.current).toBe(true); // remembered, before the answer
    await waitFor(() => expect(result.current).toBe(false));
  });
});

describe('legacy wire compat (flat flag map from a pre-rollout backend)', () => {
  it('reads flags from the old flat shape; universal answer stays null', async () => {
    apiMock.getPublicFeatures.mockResolvedValue({ player_back_button: true });
    const { useClientFeature, useUniversalAnswer } = await loadModule();
    const flag = renderHook(() => useClientFeature('player_back_button'));
    const ua = renderHook(() => useUniversalAnswer());
    await waitFor(() => expect(flag.result.current).toBe(true));
    expect(ua.result.current).toBeNull();
  });
});

describe('useUniversalAnswer', () => {
  it('serves the fetched value; null before it resolves', async () => {
    apiMock.getPublicFeatures.mockResolvedValue(wire({ player_universal_answer: true }, '11'));
    const { useUniversalAnswer } = await loadModule();
    const { result } = renderHook(() => useUniversalAnswer());
    expect(result.current).toBeNull(); // fail-closed until loaded
    await waitFor(() => expect(result.current).toBe('11'));
  });

  it('null when the server serves none (flag off or value unset)', async () => {
    apiMock.getPublicFeatures.mockResolvedValue(wire({ player_universal_answer: false }));
    const { useUniversalAnswer } = await loadModule();
    const { result } = renderHook(() => useUniversalAnswer());
    await waitFor(() => expect(apiMock.getPublicFeatures).toHaveBeenCalled());
    expect(result.current).toBeNull();
  });

  it('a failed fetch stays null (fail-closed offline)', async () => {
    apiMock.getPublicFeatures.mockRejectedValueOnce(new Error('offline'));
    const { useUniversalAnswer } = await loadModule();
    const { result } = renderHook(() => useUniversalAnswer());
    await waitFor(() => expect(apiMock.getPublicFeatures).toHaveBeenCalledTimes(1));
    expect(result.current).toBeNull();
  });
});
