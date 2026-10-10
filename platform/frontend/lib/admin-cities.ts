/**
 * Pure view-model for the admin «Города» page (the lib/admin-features.ts
 * pattern: wire types + display derivations, no React).
 *
 * The list itself is assembled by the backend (cities.rs): every city the
 * admin saved plus every city quests use, the busiest first — so a misspelt
 * city from an old draft shows up here and is merged by renaming it.
 */

import type { AdminCityWire } from './generated';
import { plural, pluralCount } from './ru';

export type { AdminCityWire };

/** Longest name / slogan — mirrors backend cities.rs (the server re-checks). */
export const CITY_NAME_MAX = 60;
export const CITY_SLOGAN_MAX = 140;

/** «3 квеста · 2 в магазине», «1 квест · не в магазине», «Нет квестов». */
export function cityUsageLabel(city: AdminCityWire): string {
  if (city.quests === 0) return 'Нет квестов';
  const store = city.in_store === 0 ? 'не в магазине' : `${city.in_store} в магазине`;
  return `${pluralCount(city.quests, 'квест', 'квеста', 'квестов')} · ${store}`;
}

/**
 * The spelling a typo shares with the real name: case, ё/е and everything
 * that is not a letter or a digit (hyphens, dots, spaces) are ignored, so
 * «Нови-Сад», «нови сад» and «Нови Сад» meet.
 */
export function cityKey(name: string): string {
  return name.toLowerCase().replace(/ё/g, 'е').replace(/[^\p{L}\p{N}]+/gu, '');
}

/**
 * For every city that looks like another listed one, the name to merge it
 * into: the busiest of the look-alikes (the list comes busiest first, so the
 * first one met). The target itself gets no suggestion.
 */
export function mergeSuggestions(cities: readonly AdminCityWire[]): Map<string, string> {
  const first = new Map<string, string>();
  const out = new Map<string, string>();
  for (const city of cities) {
    const key = cityKey(city.name);
    const target = first.get(key);
    if (target === undefined) first.set(key, city.name);
    else out.set(city.name, target);
  }
  return out;
}

/** Shown under the delete button of a city that still has quests. */
export function deleteBlockedText(city: AdminCityWire): string {
  return `Удалить нельзя: в городе ${pluralCount(city.quests, 'квест', 'квеста', 'квестов')}. Переименуйте город в другой, чтобы перенести ${plural(city.quests, 'его', 'их', 'их')}.`;
}
