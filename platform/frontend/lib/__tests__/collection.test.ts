// @vitest-environment jsdom
/**
 * lib/collection — the ONE owner of «какие квесты куплены» (issue #68).
 * Pins: one fetch shared by consumers, identity-keyed cache (a switch resets
 * and refetches; a response for a dead identity is never shown), optimistic
 * markOwned that survives a parallel refetch.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';

const { listGrantsMock, userIdMock, sessionListeners } = vi.hoisted(() => ({
  listGrantsMock: vi.fn(),
  userIdMock: vi.fn(() => 'dev:a'),
  sessionListeners: new Set<() => void>(),
}));
vi.mock('../api', () => ({ api: { listGrants: listGrantsMock } }));
vi.mock('../identity', () => ({
  currentUserId: userIdMock,
  subscribeSession: (cb: () => void) => {
    sessionListeners.add(cb);
    return () => sessionListeners.delete(cb);
  },
  getSession: () => null,
}));

import { fetchOwned, markOwned, resetCollectionForTests, useOwned, useOwns } from '../collection';

const grant = (quest_id: string) => ({ quest_id, user_id: 'dev:a', granted_at: 'now' });
const switchUser = (id: string) => {
  userIdMock.mockReturnValue(id);
  sessionListeners.forEach((cb) => cb());
};

beforeEach(() => {
  resetCollectionForTests();
  listGrantsMock.mockReset();
  switchUser('dev:a');
});

describe('useOwned / useOwns', () => {
  it('loads once and shares the result between consumers', async () => {
    listGrantsMock.mockResolvedValue([grant('q1')]);
    const a = renderHook(() => useOwned());
    const b = renderHook(() => useOwns('q1'));
    await waitFor(() => expect(a.result.current.loaded).toBe(true));
    expect(a.result.current.owned.has('q1')).toBe(true);
    expect(b.result.current).toBe(true);
    expect(listGrantsMock).toHaveBeenCalledTimes(1);
  });

  it('a grants failure leaves the set empty but loaded (buy still offered)', async () => {
    listGrantsMock.mockRejectedValue(new Error('offline'));
    const { result } = renderHook(() => useOwned());
    await waitFor(() => expect(result.current.loaded).toBe(true));
    expect(result.current.owned.size).toBe(0);
  });

  it('a failure is not cached — the next consumer mount retries', async () => {
    listGrantsMock.mockRejectedValueOnce(new Error('offline'));
    const first = renderHook(() => useOwned());
    await waitFor(() => expect(first.result.current.loaded).toBe(true));
    first.unmount();
    listGrantsMock.mockResolvedValueOnce([grant('q1')]);
    const second = renderHook(() => useOwned());
    await waitFor(() => expect(second.result.current.owned.has('q1')).toBe(true));
    expect(listGrantsMock).toHaveBeenCalledTimes(2);
  });

  it('markOwned flips every consumer at once, before any refetch', async () => {
    listGrantsMock.mockResolvedValue([]);
    const owns = renderHook(() => useOwns('q2'));
    const all = renderHook(() => useOwned());
    await waitFor(() => expect(all.result.current.loaded).toBe(true));
    expect(owns.result.current).toBe(false);
    act(() => markOwned('q2'));
    expect(owns.result.current).toBe(true);
    expect(all.result.current.owned.has('q2')).toBe(true);
  });

  it('an optimistic purchase survives a refetch that raced it', async () => {
    let resolveFetch!: (v: unknown) => void;
    listGrantsMock.mockReturnValue(new Promise((r) => { resolveFetch = r; }));
    const { result } = renderHook(() => useOwns('q3'));
    act(() => markOwned('q3'));
    // The server answer started BEFORE the purchase and does not contain q3.
    act(() => resolveFetch([grant('q1')]));
    await waitFor(() => expect(listGrantsMock).toHaveBeenCalled());
    expect(result.current).toBe(true);
  });

  it('an identity switch resets the collection and refetches for the new user', async () => {
    listGrantsMock.mockResolvedValueOnce([grant('q1')]);
    const { result } = renderHook(() => useOwned());
    await waitFor(() => expect(result.current.owned.has('q1')).toBe(true));
    listGrantsMock.mockResolvedValueOnce([]);
    act(() => switchUser('dev:b'));
    await waitFor(() => expect(result.current.loaded).toBe(true));
    expect(result.current.owned.size).toBe(0);
    expect(listGrantsMock).toHaveBeenCalledTimes(2);
  });

  it('a response that lands after an identity switch is never shown', async () => {
    let resolveOld!: (v: unknown) => void;
    listGrantsMock.mockReturnValueOnce(new Promise((r) => { resolveOld = r; }));
    const { result } = renderHook(() => useOwned());
    listGrantsMock.mockResolvedValueOnce([]);
    act(() => switchUser('dev:b'));
    await waitFor(() => expect(result.current.loaded).toBe(true));
    // The OLD user's grants arrive late — they must not leak into dev:b's view.
    act(() => resolveOld([grant('q-foreign')]));
    await Promise.resolve();
    expect(result.current.owned.size).toBe(0);
  });
});

describe('fetchOwned', () => {
  it('resolves the same set the hooks see', async () => {
    listGrantsMock.mockResolvedValue([grant('q1'), grant('q2')]);
    const owned = await fetchOwned();
    expect([...owned].sort()).toEqual(['q1', 'q2']);
    expect(listGrantsMock).toHaveBeenCalledTimes(1);
    const again = await fetchOwned();
    expect(again).toBe(owned);
    expect(listGrantsMock).toHaveBeenCalledTimes(1);
  });
});
