'use client';

import { useEffect, useState, useSyncExternalStore } from 'react';
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
  return { flags: (wire as Record<string, boolean>) ?? {}, universal_answer: null, soon_cities: [] };
}

/** The last flag verdicts this device saw — see useRememberedClientFeature. */
const REMEMBERED_KEY = 'geohod-flags:v1';
let remembered: Partial<Record<string, boolean>> | null = null;

function readRemembered(): Partial<Record<string, boolean>> {
  if (remembered) return remembered;
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(REMEMBERED_KEY) ?? '{}');
    remembered = parsed && typeof parsed === 'object' ? (parsed as Partial<Record<string, boolean>>) : {};
  } catch {
    remembered = {}; // storage blocked or corrupt — nothing remembered
  }
  return remembered;
}

function remember(flags: Partial<Record<string, boolean>>): void {
  remembered = { ...flags };
  try {
    window.localStorage.setItem(REMEMBERED_KEY, JSON.stringify(flags));
  } catch {
    // storage blocked — the next load simply has nothing to fall back on
  }
}

function fetchFeatures(): Promise<PublicFeatures> {
  if (!cache) {
    const promise = api.getPublicFeatures().then(normalizeWire).then((f) => {
      remember(f.flags ?? {});
      return f;
    });
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
  'store_my_quests',
  'store_cities',
  'quest_facts',
  'purchase_inline_login',
] as const;
export type ClientFeatureKey = (typeof CLIENT_FEATURE_KEYS)[number];

/** Effective verdict of one client-visible flag; `false` until loaded. */
export function useClientFeature(key: ClientFeatureKey): boolean {
  return usePublicFeatures()?.flags?.[key] ?? false;
}

const noSubscription = () => () => {};

/**
 * Like useClientFeature, but until the fetch answers — and whenever it fails —
 * serves the verdict this device saw last, instead of `false`. For flags that
 * reshape a whole screen or must hold offline: the store's own-quests view must
 * neither reshuffle on every load nor vanish in airplane mode, where the flag
 * can never be fetched. The price: right after an admin flips the flag, a
 * device shows its old verdict for the moment one fetch takes.
 */
export function useRememberedClientFeature(key: ClientFeatureKey): boolean {
  const fetched = usePublicFeatures();
  const last = useSyncExternalStore(noSubscription, () => readRemembered()[key] === true, () => false);
  return fetched ? (fetched.flags?.[key] ?? false) : last;
}

/**
 * Cities announced as «скоро» (the `soon_cities` setting, served only while
 * `store_cities` is on); empty while loading, on failure, and from a backend
 * that predates the field.
 */
export function useSoonCities(): readonly string[] {
  return usePublicFeatures()?.soon_cities ?? NO_CITIES;
}

const NO_CITIES: readonly string[] = Object.freeze([]);

/**
 * The platform-wide universal answer, or `null` while loading / when the
 * server serves none (flag off, value unset, or unreachable).
 */
export function useUniversalAnswer(): string | null {
  return usePublicFeatures()?.universal_answer ?? null;
}
