/**
 * IndexedDB fact queue — the durable persistence layer of the offline player (P4).
 *
 * One DB `geohod`, three stores:
 *  - `attempts`: client-born attempt identity (attempt_key UUID) so play starts fully
 *    offline; `server_attempt_id` is bound on first successful online registration.
 *  - `facts`:   the append-only local fact log, keyed by [attempt_key, natural key] —
 *    the same device-agnostic natural key the backend dedups on, so duplicate appends
 *    collapse locally exactly as they would server-side. Per-fact status `pending|sent`
 *    is the single source of "what has the server seen".
 *  - `bundles`: frozen quest snapshots keyed by immutable snapshot_id (offline play data;
 *    media assets live in a named SW Cache, not here).
 *
 * The React reducer remains the UI source of truth; this module is write-through
 * persistence. All functions are small, async and individually testable (fake-indexeddb).
 */
import { openDB, type IDBPDatabase, type DBSchema } from 'idb';
import type { Fact, QuestSnapshot } from './shared-model';

export interface AttemptRow {
  attempt_key: string;
  quest_id: string;
  snapshot_id: string;
  server_attempt_id?: string;
  created_at: string;
  last_step_idx: number;
  status: 'active' | 'superseded';
}

export interface FactRow {
  attempt_key: string;
  /** Natural-key string — see factNaturalKey. */
  key: string;
  fact: Fact;
  status: 'pending' | 'sent';
  /** Monotonic per-attempt append order (keyPath order is lexicographic — wrong for display). */
  seq: number;
  queued_at: string;
}

export interface BundleRow {
  snapshot_id: string;
  quest_id: string;
  version: number;
  snapshot: QuestSnapshot;
  size_bytes: number;
  downloaded_at: string;
}

interface GeohodDB extends DBSchema {
  attempts: {
    key: string;
    value: AttemptRow;
    indexes: { 'by-quest': string };
  };
  facts: {
    key: [string, string];
    value: FactRow;
    indexes: { 'by-attempt': string };
  };
  bundles: {
    key: string;
    value: BundleRow;
    indexes: { 'by-quest': string };
  };
}

const DB_NAME = 'geohod';
const DB_VERSION = 1;

let dbPromise: Promise<IDBPDatabase<GeohodDB>> | null = null;

function db(): Promise<IDBPDatabase<GeohodDB>> {
  if (!dbPromise) {
    dbPromise = openDB<GeohodDB>(DB_NAME, DB_VERSION, {
      upgrade(database) {
        const attempts = database.createObjectStore('attempts', { keyPath: 'attempt_key' });
        attempts.createIndex('by-quest', 'quest_id');
        const facts = database.createObjectStore('facts', { keyPath: ['attempt_key', 'key'] });
        facts.createIndex('by-attempt', 'attempt_key');
        const bundles = database.createObjectStore('bundles', { keyPath: 'snapshot_id' });
        bundles.createIndex('by-quest', 'quest_id');
      },
    });
  }
  return dbPromise;
}

/** Test hook: drop the cached connection so a fresh IDBFactory takes effect. */
export function __resetQueueForTests(): void {
  if (dbPromise) {
    dbPromise.then((d) => d.close()).catch(() => {});
  }
  dbPromise = null;
}

/** Device-agnostic natural key — mirrors the backend dedup tuple exactly. */
export function factNaturalKey(f: Fact): string {
  return JSON.stringify([f.type, f.step_position, f.submitted_value ?? null, f.coins_delta, f.note ?? null]);
}

// ---------- attempts ----------

/** The single active attempt for a quest, or null. */
export async function getActiveAttempt(questId: string): Promise<AttemptRow | null> {
  const rows = await (await db()).getAllFromIndex('attempts', 'by-quest', questId);
  return rows.find((r) => r.status === 'active') ?? null;
}

/** Get-or-create the active attempt (attempts are born offline, no network needed). */
export async function ensureActiveAttempt(questId: string, snapshotId: string): Promise<AttemptRow> {
  const existing = await getActiveAttempt(questId);
  if (existing) return existing;
  const row: AttemptRow = {
    attempt_key: crypto.randomUUID(),
    quest_id: questId,
    snapshot_id: snapshotId,
    created_at: new Date().toISOString(),
    last_step_idx: 0,
    status: 'active',
  };
  await (await db()).put('attempts', row);
  return row;
}

/** Bind the server attempt id after the first successful online registration. */
export async function setServerAttemptId(attemptKey: string, serverAttemptId: string): Promise<void> {
  const d = await db();
  const row = await d.get('attempts', attemptKey);
  if (!row) return;
  await d.put('attempts', { ...row, server_attempt_id: serverAttemptId });
}

/** Persist the resume position (write-through on advance). */
export async function setLastStepIdx(attemptKey: string, idx: number): Promise<void> {
  const d = await db();
  const row = await d.get('attempts', attemptKey);
  if (!row) return;
  await d.put('attempts', { ...row, last_step_idx: idx });
}

/**
 * «Начать заново»: supersede the active attempt and start a fresh one.
 * Facts of the old attempt are never deleted — coins already earned remain
 * (locally and on the server; facts are immutable).
 */
export async function restartAttempt(questId: string, snapshotId: string): Promise<AttemptRow> {
  const current = await getActiveAttempt(questId);
  if (current) {
    await (await db()).put('attempts', { ...current, status: 'superseded' });
  }
  return ensureActiveAttempt(questId, snapshotId);
}

// ---------- facts ----------

/**
 * Write-through append. Duplicate natural keys collapse to the existing row
 * (server-mirror idempotency); an already-`sent` row is never demoted.
 */
export async function appendFact(attemptKey: string, fact: Fact): Promise<void> {
  const d = await db();
  const key = factNaturalKey(fact);
  const tx = d.transaction('facts', 'readwrite');
  const existing = await tx.store.get([attemptKey, key]);
  if (!existing) {
    const siblings = await tx.store.index('by-attempt').getAll(attemptKey);
    const seq = siblings.reduce((m, r) => Math.max(m, r.seq), 0) + 1;
    await tx.store.put({ attempt_key: attemptKey, key, fact, status: 'pending', seq, queued_at: new Date().toISOString() });
  }
  await tx.done;
}

/** All facts of an attempt in append order. */
export async function getFacts(attemptKey: string): Promise<FactRow[]> {
  const rows = await (await db()).getAllFromIndex('facts', 'by-attempt', attemptKey);
  return rows.sort((a, b) => a.seq - b.seq);
}

/** Facts the server has not acknowledged yet, in append order. */
export async function getPendingFacts(attemptKey: string): Promise<FactRow[]> {
  return (await getFacts(attemptKey)).filter((r) => r.status === 'pending');
}

/**
 * Flip a flushed batch to `sent`. A successful POST means every fact in the
 * batch is on the server (newly accepted or already known) — caller passes the
 * natural keys of exactly that batch.
 */
export async function markSent(attemptKey: string, keys: string[]): Promise<void> {
  const d = await db();
  const tx = d.transaction('facts', 'readwrite');
  for (const key of keys) {
    const row = await tx.store.get([attemptKey, key]);
    if (row && row.status !== 'sent') {
      await tx.store.put({ ...row, status: 'sent' });
    }
  }
  await tx.done;
}

// ---------- bundles ----------

/** Store a downloaded frozen snapshot (immutable — keyed by snapshot_id). */
export async function putBundle(row: BundleRow): Promise<void> {
  await (await db()).put('bundles', row);
}

export async function getBundle(snapshotId: string): Promise<BundleRow | null> {
  return (await (await db()).get('bundles', snapshotId)) ?? null;
}

/** Latest downloaded bundle for a quest (highest version), or null. */
export async function getLatestBundleForQuest(questId: string): Promise<BundleRow | null> {
  const rows = await (await db()).getAllFromIndex('bundles', 'by-quest', questId);
  if (rows.length === 0) return null;
  return rows.reduce((best, r) => (r.version > best.version ? r : best));
}

/** All downloaded bundles (My Quests download states). */
export async function listBundles(): Promise<BundleRow[]> {
  return (await db()).getAll('bundles');
}

// ---------- legacy localStorage migration ----------

/** The pre-P4 persistence shape written by the localStorage player. */
interface LegacySave {
  facts: Fact[];
  stepIdx: number;
  attemptId?: string;
}

/**
 * One-time import of the pre-P4 localStorage save into the queue.
 * Key deletion is the migration marker: IDB writes commit first, so a crash
 * mid-migration re-runs it idempotently (puts collapse by natural key).
 * Returns true when a save was imported.
 */
export async function migrateLegacyLocalStorage(
  questId: string,
  snapshotId: string,
  storage: Pick<Storage, 'getItem' | 'removeItem'>
): Promise<boolean> {
  const legacyKey = `quest-player-${questId}`;
  const raw = storage.getItem(legacyKey);
  if (!raw) return false;

  let saved: LegacySave;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed !== 'object' || parsed === null ||
      !Array.isArray((parsed as LegacySave).facts) ||
      typeof (parsed as LegacySave).stepIdx !== 'number'
    ) {
      throw new Error('unrecognized legacy save shape');
    }
    saved = parsed as LegacySave;
  } catch {
    storage.removeItem(legacyKey); // corrupt — discard rather than re-fail every mount
    return false;
  }

  const attempt = await ensureActiveAttempt(questId, snapshotId);
  for (const fact of saved.facts) {
    await appendFact(attempt.attempt_key, fact);
  }
  await setLastStepIdx(attempt.attempt_key, saved.stepIdx);
  // The old `demo-` placeholder is a client convention, not a server identity.
  if (saved.attemptId && !saved.attemptId.startsWith('demo-')) {
    await setServerAttemptId(attempt.attempt_key, saved.attemptId);
  }
  storage.removeItem(legacyKey);
  return true;
}
