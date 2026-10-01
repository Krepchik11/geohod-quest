'use client';

import { useSyncExternalStore } from 'react';

/**
 * The city the player last picked above the shop (`store_cities`), remembered on
 * this device so the next visit opens on it. One module-wide value with
 * subscribers, read through useSyncExternalStore: no effect, no flash of the
 * default city on a remembered device.
 */
const KEY = 'geohod-city:v1';
let cached: string | null | undefined;
const listeners = new Set<() => void>();

function read(): string | null {
  if (cached !== undefined) return cached;
  try {
    cached = window.localStorage.getItem(KEY);
  } catch {
    cached = null; // storage blocked — every visit starts from the default city
  }
  return cached;
}

function subscribe(onChange: () => void): () => void {
  listeners.add(onChange);
  return () => listeners.delete(onChange);
}

/** Remember the picked city and tell every reader. */
export function saveCity(city: string): void {
  cached = city;
  try {
    window.localStorage.setItem(KEY, city);
  } catch {
    // storage blocked — the pick still holds for this page
  }
  listeners.forEach((l) => l());
}

/** The remembered city, or null (server render, nothing saved, storage blocked). */
export function useSavedCity(): string | null {
  return useSyncExternalStore(subscribe, read, () => null);
}
