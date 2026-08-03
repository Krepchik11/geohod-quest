/**
 * TDD for lib/session-actions.logoutAndReset — the full clean-slate logout:
 * flush-while-authed → clear+rotate session → wipe local play. Guards the data
 * paths that keep flushAll (profile/app sweep) safe under a rotated identity.
 */
import 'fake-indexeddb/auto';
import { describe, expect, it, beforeEach, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import type { Fact } from '../shared-model';
import type { QuestSnapshot } from '../shared-model';

/** Minimal localStorage shim (node env — mirrors identity.test). */
class StorageShim {
  private map = new Map<string, string>();
  getItem(k: string) { return this.map.has(k) ? this.map.get(k)! : null; }
  setItem(k: string, v: string) { this.map.set(k, String(v)); }
  removeItem(k: string) { this.map.delete(k); }
  clear() { this.map.clear(); }
}
(globalThis as Record<string, unknown>).localStorage = new StorageShim();

// Network api is mocked before the module-under-test imports it (no real fetch).
const { createAttempt, appendFacts, checkout } = vi.hoisted(() => ({
  createAttempt: vi.fn(),
  appendFacts: vi.fn(),
  checkout: vi.fn(),
}));
vi.mock('../api', () => ({ api: { createAttempt, appendFacts, checkout } }));

import {
  ensureActiveAttempt,
  appendFact,
  listAttempts,
  getBundle,
  putBundle,
  __resetQueueForTests,
} from '../queue';
import { setSession, getSession, getDeviceId, type Session } from '../identity';
import { __resetSyncForTests } from '../sync';
import { logoutAndReset } from '../session-actions';

const SESSION: Session = {
  token: 't'.repeat(64),
  user_id: 'dev:account-1111',
  email: 'a@example.com',
  display_name: null,
};

const SNAPSHOT = { golden_id: 'g', name: 'n', snapshot_version: 1, steps: [] } as QuestSnapshot;

function fact(partial: Partial<Fact> = {}): Fact {
  return {
    type: 'attempt_completed',
    step_position: 3,
    submitted_value: null,
    local_is_correct: true,
    coins_delta: 0,
    note: null,
    device_id: 'device-a',
    ...partial,
  };
}

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory();
  localStorage.clear();
  __resetQueueForTests();
  __resetSyncForTests();
  createAttempt.mockReset().mockResolvedValue({ attempt_id: 'srv-1', snapshot_id: 'snap-v1' });
  appendFacts.mockReset().mockResolvedValue({
    accepted: [],
    projected: { balance: 5, completed_steps: [], revealed_hints: [] },
  });
  checkout.mockReset().mockResolvedValue({});
});

describe('logoutAndReset', () => {
  it('flushes pending facts, then clears the session, rotates the device, and wipes local play', async () => {
    setSession(SESSION);
    const deviceBefore = getDeviceId();

    const a = await ensureActiveAttempt('q1', 'snap-v1');
    await appendFact(a.attempt_key, fact());
    await putBundle({
      snapshot_id: 'snap-v1', quest_id: 'q1', version: 1,
      snapshot: SNAPSHOT, size_bytes: 10, downloaded_at: new Date(0).toISOString(),
    });

    await logoutAndReset();

    // 1) the pending completion reached the server BEFORE the wipe
    expect(appendFacts).toHaveBeenCalledTimes(1);
    // 2) session gone, 3) device id rotated, 4) attempts + bundles wiped
    expect(getSession()).toBeNull();
    expect(getDeviceId()).not.toBe(deviceBefore);
    expect(await listAttempts()).toHaveLength(0);
    expect(await getBundle('snap-v1')).toBeNull();
  });

  it('still clears the session and wipes local play when the flush fails (offline)', async () => {
    setSession(SESSION);
    // Neither registration nor the checkout fallback can complete.
    createAttempt.mockRejectedValue(new Error('offline'));
    checkout.mockRejectedValue(new Error('offline'));

    const a = await ensureActiveAttempt('q1', 'snap-v1');
    await appendFact(a.attempt_key, fact());

    await expect(logoutAndReset()).resolves.toBeUndefined();
    expect(getSession()).toBeNull();
    expect(await listAttempts()).toHaveLength(0); // wiped despite the failed flush
  });
});
