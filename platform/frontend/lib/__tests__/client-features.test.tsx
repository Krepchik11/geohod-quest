// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';

/**
 * useClientFeature — the player runtime's view of GET /api/features
 * (client-visible flags only). Fail-closed: `false` until the fetch resolves,
 * `false` for unknown keys, `false` when the server is unreachable.
 */
const { apiMock } = vi.hoisted(() => ({
  apiMock: { getPublicFeatures: vi.fn() },
}));
vi.mock('../api', () => ({ api: apiMock }));

beforeEach(() => {
  vi.resetModules();
  apiMock.getPublicFeatures.mockReset();
});

async function loadHook() {
  const mod = await import('../client-features');
  return mod.useClientFeature;
}

describe('useClientFeature', () => {
  it('serves the fetched verdict; false before it resolves', async () => {
    apiMock.getPublicFeatures.mockResolvedValue({ player_back_button: true });
    const useClientFeature = await loadHook();
    const { result } = renderHook(() => useClientFeature('player_back_button'));
    expect(result.current).toBe(false); // fail-closed until loaded
    await waitFor(() => expect(result.current).toBe(true));
  });

  it('unknown keys are false even after load', async () => {
    apiMock.getPublicFeatures.mockResolvedValue({ player_back_button: true });
    const useClientFeature = await loadHook();
    const { result } = renderHook(() => useClientFeature('no_such_flag'));
    await waitFor(() => expect(apiMock.getPublicFeatures).toHaveBeenCalled());
    expect(result.current).toBe(false);
  });

  it('one fetch serves every consumer (module-level cache)', async () => {
    apiMock.getPublicFeatures.mockResolvedValue({ player_back_button: true });
    const useClientFeature = await loadHook();
    const a = renderHook(() => useClientFeature('player_back_button'));
    const b = renderHook(() => useClientFeature('player_back_button'));
    await waitFor(() => expect(a.result.current).toBe(true));
    await waitFor(() => expect(b.result.current).toBe(true));
    expect(apiMock.getPublicFeatures).toHaveBeenCalledTimes(1);
  });

  it('a failed fetch stays false and is not cached (next mount retries)', async () => {
    apiMock.getPublicFeatures.mockRejectedValueOnce(new Error('offline'));
    const useClientFeature = await loadHook();
    const first = renderHook(() => useClientFeature('player_back_button'));
    await waitFor(() => expect(apiMock.getPublicFeatures).toHaveBeenCalledTimes(1));
    expect(first.result.current).toBe(false);
    first.unmount();

    apiMock.getPublicFeatures.mockResolvedValue({ player_back_button: true });
    const second = renderHook(() => useClientFeature('player_back_button'));
    await waitFor(() => expect(second.result.current).toBe(true));
  });
});
