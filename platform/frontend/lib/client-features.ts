'use client';

import { useEffect, useState } from 'react';
import { api, type PublicFeatures } from './api';

/**
 * Client-visible feature flags + player runtime values (GET /api/features —
 * only flags the backend marks `client_visible`, never the server-enforced
 * auth/payments toggles, plus the platform-wide universal answer when the
 * `player_universal_answer` flag is on and a value is set).
 *
 * Fail-closed by design: a flag reads `false` (and the universal answer
 * `null`) until the fetch resolves, for unknown keys, and when the server is
 * unreachable — flag-gated behavior may appear a moment after mount but can
 * never flicker ON by mistake.
 *
 * Fetched once per page load and shared module-wide (the use-me.ts pattern):
 * flags change through rare admin action, so a reload is an acceptable
 * propagation boundary. A failed fetch is never cached — the next mount retries.
 */
let cache: Promise<PublicFeatures> | null = null;

/**
 * TRANSITIONAL (remove after the backend serving `{flags, universal_answer}`
 * is rolled out everywhere): the pre-universal-answer backend served the flat
 * `{key: bool}` map. During a frontend-first rolling deploy the new client
 * must not read every flag as false against the old shape.
 */
function normalizeWire(wire: PublicFeatures | Record<string, boolean>): PublicFeatures {
  if (wire && typeof wire === 'object' && 'flags' in wire) return wire as PublicFeatures;
  return { flags: (wire as Record<string, boolean>) ?? {}, universal_answer: null };
}

function fetchFeatures(): Promise<PublicFeatures> {
  if (!cache) {
    const promise = api.getPublicFeatures().then(normalizeWire);
    cache = promise;
    promise.catch(() => {
      if (cache === promise) cache = null;
    });
  }
  return cache;
}

/** The loaded wire object, or `null` until the fetch resolves / on failure. */
function usePublicFeatures(): PublicFeatures | null {
  const [features, setFeatures] = useState<PublicFeatures | null>(null);
  useEffect(() => {
    let cancelled = false;
    fetchFeatures()
      .then((f) => {
        if (!cancelled) setFeatures(f);
      })
      .catch(() => {
        /* fail-closed: flags stay false, the universal answer stays null */
      });
    return () => {
      cancelled = true;
    };
  }, []);
  return features;
}

/**
 * Flags the player runtime may read — the client_visible slice of the registry
 * (goldens/wire/features-registry.json pins it). A typo in a screen's flag
 * name is a compile error, not a silently-off feature.
 */
export const CLIENT_FEATURE_KEYS = [
  'player_back_button',
  'player_universal_answer',
  'quest_share',
] as const;
export type ClientFeatureKey = (typeof CLIENT_FEATURE_KEYS)[number];

/** Effective verdict of one client-visible flag; `false` until loaded. */
export function useClientFeature(key: ClientFeatureKey): boolean {
  return usePublicFeatures()?.flags?.[key] ?? false;
}

/**
 * The platform-wide universal answer, or `null` while loading / when the
 * server serves none (flag off, value unset, or unreachable).
 */
export function useUniversalAnswer(): string | null {
  return usePublicFeatures()?.universal_answer ?? null;
}
