'use client';

import { useEffect, useSyncExternalStore } from 'react';
import { api, type AdminModerationCounts } from './api';

/**
 * What waits for a moderator — the counters on the admin tabs (Отзывы,
 * Обратная связь) and on the site header's «админка». One module-level value
 * shared by every badge on the page; a moderation action calls
 * `refreshModerationCounts()` and every badge follows.
 *
 * Admin-only: a caller enables the read once it knows the viewer is an admin.
 * A failed read keeps the last value (or none) — a badge is a hint, never a gate.
 */

let counts: AdminModerationCounts | null = null;
// Only the newest read may land: a refresh started after an action must not be
// overwritten by a slower read that started before it.
let generation = 0;
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Re-read the counters, e.g. right after a check, a hide or a resolve. */
export function refreshModerationCounts(): void {
  const mine = ++generation;
  api.adminModerationCounts().then(
    (next) => {
      if (mine !== generation) return;
      counts = next;
      for (const l of listeners) l();
    },
    () => {},
  );
}

/** The counters for an admin viewer (read on mount); `null` otherwise or until read. */
export function useModerationCounts(enabled: boolean): AdminModerationCounts | null {
  const value = useSyncExternalStore(subscribe, () => counts, () => null);
  useEffect(() => {
    if (enabled) refreshModerationCounts();
  }, [enabled]);
  return enabled ? value : null;
}

/** Everything waiting across both moderation tabs — the site header's «админка». */
export function waitingTotal(c: AdminModerationCounts | null): number {
  return c ? c.reviews_new + c.feedback_open : 0;
}
