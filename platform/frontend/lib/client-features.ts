'use client';

import { useEffect, useState } from 'react';
import { api } from './api';

/**
 * Client-visible feature flags (GET /api/features — only flags the backend
 * marks `client_visible`, never the server-enforced auth/payments toggles).
 *
 * Fail-closed by design: a flag reads `false` until the fetch resolves, for
 * unknown keys, and when the server is unreachable — flag-gated behavior may
 * appear a moment after mount but can never flicker ON by mistake.
 *
 * Fetched once per page load and shared module-wide (the use-me.ts pattern):
 * flags change through rare admin action, so a reload is an acceptable
 * propagation boundary. A failed fetch is never cached — the next mount retries.
 */
let cache: Promise<Record<string, boolean>> | null = null;

function fetchFeatures(): Promise<Record<string, boolean>> {
  if (!cache) {
    const promise = api.getPublicFeatures();
    cache = promise;
    promise.catch(() => {
      if (cache === promise) cache = null;
    });
  }
  return cache;
}

/** Effective verdict of one client-visible flag; `false` until loaded. */
export function useClientFeature(key: string): boolean {
  const [flags, setFlags] = useState<Record<string, boolean> | null>(null);
  useEffect(() => {
    let cancelled = false;
    fetchFeatures()
      .then((f) => {
        if (!cancelled) setFlags(f);
      })
      .catch(() => {
        /* fail-closed: the flag simply stays false */
      });
    return () => {
      cancelled = true;
    };
  }, []);
  return flags?.[key] ?? false;
}
