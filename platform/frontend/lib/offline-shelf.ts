/**
 * The store's offline shelf: what the shop shows when the catalog can't be
 * fetched — the player's own quests, as this device last saw them.
 *
 * Remembered in localStorage on every successful store load: the catalog
 * (public; it only dresses the cards) and the grants of the identity that
 * loaded it. The service worker deliberately never caches API answers (one
 * stale source of truth is one too many), so this lives at the app level and
 * is read ONLY when the network is gone — never to decide anything online.
 */
import type { PublishedQuestWire } from './api';
import { DEFAULT_DISTANCE_KM, DEFAULT_DURATION_MIN } from './storefront';
import { listBundles, type BundleRow } from './queue';

const CATALOG_KEY = 'geohod-catalog:v1';
const GRANTS_KEY = 'geohod-grants:v1';

function write(key: string, value: unknown): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // storage blocked or full — offline simply shows less
  }
}

function read<T>(key: string): T | null {
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

export function rememberCatalog(quests: readonly PublishedQuestWire[]): void {
  write(CATALOG_KEY, quests);
}

/** quest_id → granted_at for `userId`; written only once its grants answered. */
export function rememberGrants(userId: string, grantedAt: ReadonlyMap<string, string>): void {
  write(GRANTS_KEY, { userId, grants: [...grantedAt] });
}

function rememberedGrants(userId: string): Map<string, string> {
  const saved = read<{ userId: string; grants: [string, string][] }>(GRANTS_KEY);
  // Another identity's grants (logout rotated the device id) are not ours.
  return saved?.userId === userId && Array.isArray(saved.grants) ? new Map(saved.grants) : new Map();
}

/** A card for a downloaded quest the remembered catalog doesn't know. */
function cardFromBundle(b: BundleRow): PublishedQuestWire {
  return {
    quest_id: b.quest_id,
    name: b.snapshot.name,
    city: b.snapshot.city ?? null,
    duration: b.snapshot.duration ?? null,
    // A snapshot carries no numbers; the owner's rule holds for every quest.
    duration_min: DEFAULT_DURATION_MIN,
    distance_km: DEFAULT_DISTANCE_KM,
    snapshot_id: b.snapshot_id,
    snapshot_version: b.version,
    primary_comic: null,
    template_summary: '',
    description: null,
    price: null,
    rating_avg: 0,
    rating_count: 0,
    players: 0,
    complexity: null,
    age_target: null,
    tags: [],
    pages: null,
    tasks: null,
    paid_hints: null,
  };
}

export interface OfflineShelf {
  /** The player's own quests only — nothing can be bought offline. */
  quests: PublishedQuestWire[];
  owned: ReadonlySet<string>;
  grantedAt: ReadonlyMap<string, string>;
}

/** Own quests = remembered grants ∪ downloaded bundles (a bundle needs a grant). */
export async function loadOfflineShelf(userId: string): Promise<OfflineShelf> {
  const grantedAt = rememberedGrants(userId);
  const bundles = await listBundles().catch(() => [] as BundleRow[]);
  const newest = new Map<string, BundleRow>();
  for (const b of bundles) {
    const seen = newest.get(b.quest_id);
    if (!seen || b.version > seen.version) newest.set(b.quest_id, b);
  }
  const catalog = new Map((read<PublishedQuestWire[]>(CATALOG_KEY) ?? []).map((q) => [q.quest_id, q]));
  const quests: PublishedQuestWire[] = [];
  for (const id of new Set([...grantedAt.keys(), ...newest.keys()])) {
    const known = catalog.get(id);
    const bundle = newest.get(id);
    if (known) quests.push(known);
    else if (bundle) quests.push(cardFromBundle(bundle));
  }
  return { quests, owned: new Set(quests.map((q) => q.quest_id)), grantedAt };
}

/** Logout: the rotated identity must not inherit the remembered grants. */
export function forgetGrants(): void {
  try {
    window.localStorage.removeItem(GRANTS_KEY);
  } catch {
    // nothing to forget
  }
}
