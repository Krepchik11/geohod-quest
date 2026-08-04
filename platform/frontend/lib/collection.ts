'use client';

import { useEffect, useSyncExternalStore } from 'react';
import { api } from './api';
import { currentUserId, subscribeSession } from './identity';

/**
 * ONE owner of «какие квесты куплены» (issue #68), modeled on use-me.ts.
 *
 * The store is keyed by `currentUserId()` (works for anonymous devices too):
 * an identity switch resets it and refetches, and a response that lands for a
 * previous identity is keyed by a dead store and dropped — the «чужие покупки
 * после смены аккаунта» class of bugs is closed constructively.
 *
 * The server scopes /api/grants to the caller, so there is no client-side
 * user filter here — the filter the pages used to apply was dead AND racy.
 *
 * `markOwned` is optimistic: purchases flip every open screen at once. The
 * optimistic ids live in their own per-user set and are unioned over the
 * server set, so a refetch that raced the purchase cannot swallow it.
 *
 * A failed fetch settles the UI (`loaded: true`, empty set — buying is still
 * offered) but is never cached: the next consumer mount retries, like use-me.
 */

interface OwnedSnapshot {
  /** Bought quest ids for the CURRENT identity. */
  owned: ReadonlySet<string>;
  /** False until the first grants answer (success or failure) for this identity. */
  loaded: boolean;
}

interface Store {
  userId: string;
  server: ReadonlySet<string>;
  optimistic: Set<string>;
  loaded: boolean;
  inflight: Promise<ReadonlySet<string>> | null;
  snapshot: OwnedSnapshot;
}

const EMPTY: ReadonlySet<string> = new Set();
const SERVER_SNAPSHOT: OwnedSnapshot = { owned: EMPTY, loaded: false };

let store: Store | null = null;
const listeners = new Set<() => void>();
let unsubSession: (() => void) | null = null;

function rebuildSnapshot(s: Store): void {
  const owned = new Set(s.server);
  for (const id of s.optimistic) owned.add(id);
  s.snapshot = { owned, loaded: s.loaded };
  listeners.forEach((cb) => cb());
}

/**
 * The store for the CURRENT identity, dropping any previous identity's data.
 * Mutating accessor — for effects and event handlers, never for render.
 */
function ensureStore(): Store {
  const userId = currentUserId();
  if (store?.userId !== userId) {
    store = {
      userId,
      server: EMPTY,
      optimistic: new Set(),
      loaded: false,
      inflight: null,
      snapshot: SERVER_SNAPSHOT,
    };
    rebuildSnapshot(store);
  }
  return store;
}

function load(s: Store): Promise<ReadonlySet<string>> {
  if (!s.inflight) {
    s.inflight = api.listGrants().then(
      (grants) => {
        // Keyed by the store the request was made for: after an identity
        // switch `store` points elsewhere and this answer is dropped.
        if (store === s) {
          s.server = new Set(grants.map((g) => g.quest_id));
          s.loaded = true;
          rebuildSnapshot(s);
        }
        return s.snapshot.owned;
      },
      () => {
        if (store === s) {
          s.loaded = true;
          s.inflight = null;
          rebuildSnapshot(s);
        }
        return s.snapshot.owned;
      },
    );
  }
  return s.inflight;
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  // ONE session listener for the whole store, ref-counted by consumers.
  if (listeners.size === 1) {
    unsubSession = subscribeSession(() => {
      void load(ensureStore());
    });
  }
  return () => {
    listeners.delete(cb);
    if (listeners.size === 0) {
      unsubSession?.();
      unsubSession = null;
    }
  };
}

/** Pure read for useSyncExternalStore — never mutates, never notifies. */
function getSnapshot(): OwnedSnapshot {
  return store && store.userId === currentUserId() ? store.snapshot : SERVER_SNAPSHOT;
}

/** Bought quest ids + whether the first answer arrived. Shared, identity-keyed. */
export function useOwned(): OwnedSnapshot {
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, () => SERVER_SNAPSHOT);
  // Mount-time load; identity switches are handled by the session listener.
  useEffect(() => {
    void load(ensureStore());
  }, []);
  return snapshot;
}

/** Does the current identity own this quest (optimistic purchases included)? */
export function useOwns(questId: string): boolean {
  return useOwned().owned.has(questId);
}

/** Promise-style read for non-hook flows (my-quests loader). */
export function fetchOwned(): Promise<ReadonlySet<string>> {
  const s = ensureStore();
  return s.loaded && s.inflight ? Promise.resolve(s.snapshot.owned) : load(s);
}

/** Record a purchase optimistically — every open screen flips at once. */
export function markOwned(questId: string): void {
  const s = ensureStore();
  s.optimistic.add(questId);
  rebuildSnapshot(s);
}

/** Mandatory in beforeEach of every suite that statically imports a consumer page. */
export function resetCollectionForTests(): void {
  store = null;
  listeners.clear();
  unsubSession?.();
  unsubSession = null;
}
