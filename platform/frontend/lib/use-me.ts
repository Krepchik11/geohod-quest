'use client';

import { useEffect, useState, useSyncExternalStore } from 'react';
import { api } from './api';
import { getSession, subscribeSession, type Session } from './identity';

/**
 * ONE hook for "who is looking at the page": the live session plus the
 * AUTHORITATIVE role/name from /api/users/me.
 *
 * The role stored in the session is a snapshot from login and can be STALE —
 * e.g. you registered (default role player) and were then promoted to
 * admin/editor via the ops token, so role-gated nav would never appear until a
 * re-login. The /me re-fetch surfaces role changes immediately; the session
 * snapshot is the instant, offline-safe fallback.
 *
 * Several header islands (site header, tab bar, user menu) render on the same
 * page, so the fetch is cached per session token at module level — one network
 * round-trip, shared by all of them. The result is keyed by the token it
 * belongs to, so it is ignored after a logout / account switch.
 */

export interface MeInfo {
  role: string | null;
  displayName: string | null;
}

let cache: { token: string; promise: Promise<MeInfo> } | null = null;

/**
 * The token-keyed /me cache itself — ONE network round-trip per session token,
 * shared by every consumer (useMe below, and the admin access gate, which needs
 * the raw rejection to tell 401/403 from a network failure).
 */
export function fetchMe(token: string): Promise<MeInfo> {
  if (cache?.token !== token) {
    const promise = api.me().then((me) => ({ role: me.role, displayName: me.display_name }));
    cache = { token, promise };
    // Never cache a failure — the next mount retries.
    promise.catch(() => {
      if (cache?.token === token) cache = null;
    });
  }
  return cache.promise;
}

export function useMe(): {
  session: Session | null;
  /** Authoritative role once /me resolves; login-snapshot fallback until then;
   *  undefined when anonymous. */
  role: string | null | undefined;
  displayName: string | null;
} {
  // SSR snapshot is null (anonymous) — reconciled on the client without a
  // hydration mismatch.
  const session = useSyncExternalStore(subscribeSession, getSession, () => null);
  const [fetched, setFetched] = useState<({ token: string } & MeInfo) | null>(null);

  useEffect(() => {
    if (!session) return;
    let cancelled = false;
    const token = session.token;
    fetchMe(token)
      .then((me) => {
        if (!cancelled) setFetched({ token, ...me });
      })
      .catch(() => {
        /* offline / transient: keep using the session-snapshot values */
      });
    return () => {
      cancelled = true;
    };
  }, [session]);

  const fresh = session && fetched?.token === session.token ? fetched : null;
  return {
    session,
    role: session ? (fresh ? fresh.role : session.role) : undefined,
    displayName: session ? (fresh ? fresh.displayName : (session.display_name ?? null)) : null,
  };
}
