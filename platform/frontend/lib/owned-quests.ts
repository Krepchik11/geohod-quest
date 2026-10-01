/**
 * One owned quest as THIS device knows it: where the player is in it (the local
 * attempt log) and what is downloaded (the bundles store). Device-local by
 * design, like the player itself — it answers offline and before any fetch.
 * Shared by the store's own-quest cards and «Мои квесты».
 */
import { latestRating, projectState, type Fact } from './shared-model';
import {
  getActiveAttempt,
  getAttemptsForQuest,
  getBundle,
  getFacts,
  getLatestBundleForQuest,
  listAttempts,
  type AttemptRow,
  type BundleRow,
} from './queue';

export type OwnedState = 'new' | 'progress' | 'done';

export interface OwnedStatus {
  state: OwnedState;
  /** 1-based step the player is on (progress), and the quest's step count. */
  pos?: number;
  total?: number;
  /** When the active attempt began. */
  attemptDate?: string;
  /** The last thing that happened: the newest fact of a running attempt, the
   *  completion of a finished one. Orders own quests within their state. */
  lastActivity?: string;
  /** The player's own finale rating (1–5), 0 = none. */
  myRating: number;
  /** Newest downloaded version, or null. */
  bundle: BundleRow | null;
  /** A newer version is published than the downloaded one (unknown offline). */
  updateAvailable: boolean;
}

/** A quest with nothing played and nothing downloaded (no local trace yet). */
export const FRESH_STATUS: OwnedStatus = { state: 'new', myRating: 0, bundle: null, updateAvailable: false };

const completion = (facts: readonly Fact[]) => facts.find((f) => f.type === 'attempt_completed');

/** «28.06.2026» — dates on own quests carry the year. */
export function formatDate(iso: string | undefined): string {
  if (!iso) return '';
  return new Date(iso).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

/** The one honest CTA per state. */
export function ctaFor(state: OwnedState): { label: string; variant: 'primary' | 'secondary'; restart: boolean } {
  if (state === 'progress') return { label: 'Продолжить', variant: 'primary', restart: false };
  if (state === 'done') return { label: 'Пройти заново', variant: 'secondary', restart: true };
  return { label: 'Начать', variant: 'primary', restart: false };
}

/** Downloaded with every image, so it plays offline as it does online. */
export function isOfflineReady(s: OwnedStatus): boolean {
  return !!s.bundle && s.bundle.media_complete !== false;
}

/**
 * The quest's status. `publishedSnapshotId` is the version the server serves
 * now, or null when it is unknown (offline) — then no update is claimed.
 */
export async function ownedStatus(questId: string, publishedSnapshotId: string | null): Promise<OwnedStatus> {
  const [active, latest] = await Promise.all([getActiveAttempt(questId), getLatestBundleForQuest(questId)]);
  // A finished quest removed from the device keeps its finish: removal retires
  // the completed attempt (lib/download.removeDownloadedQuest), so look there.
  const attempt = active ?? (await lastCompletedAttempt(questId));
  const rows = attempt ? await getFacts(attempt.attempt_key) : [];
  const facts = rows.map((r) => r.fact);
  const doneRow = rows.find((r) => r.fact.type === 'attempt_completed');
  const bound = attempt && attempt.snapshot_id !== latest?.snapshot_id ? await getBundle(attempt.snapshot_id) : null;
  const total = (bound ?? latest)?.snapshot.steps.length;

  const status: OwnedStatus = {
    state: 'new',
    myRating: latestRating(facts),
    bundle: latest,
    updateAvailable: !!latest && publishedSnapshotId !== null && latest.snapshot_id !== publishedSnapshotId,
  };
  if (doneRow) {
    return { ...status, state: 'done', total, attemptDate: attempt?.created_at, lastActivity: doneRow.queued_at };
  }
  if (!active || (facts.length === 0 && active.last_step_idx === 0)) return status;

  const completed = projectState(facts).completedSteps;
  const resumed = active.last_step_idx + 1;
  const pos = completed.length > 0 && total ? Math.min(Math.max(...completed) + 2, total) : Math.min(resumed, total ?? resumed);
  return {
    ...status,
    state: 'progress',
    pos,
    total,
    attemptDate: active.created_at,
    lastActivity: rows[rows.length - 1]?.queued_at ?? active.created_at,
  };
}

async function lastCompletedAttempt(questId: string): Promise<AttemptRow | null> {
  const attempts = (await getAttemptsForQuest(questId)).sort((a, b) => b.created_at.localeCompare(a.created_at));
  for (const a of attempts) {
    if (completion((await getFacts(a.attempt_key)).map((r) => r.fact))) return a;
  }
  return null;
}

const RANK: Record<OwnedState, number> = { progress: 0, new: 1, done: 2 };

/**
 * Own quests in the store's order: в процессе → не начатые → пройденные, the
 * most recent first within each — the last played, the last received (a grant
 * not answered yet is a purchase made a moment ago: newest of all), the last
 * finished. Ties keep the catalog order.
 */
export function orderOwned<T extends { quest_id: string }>(
  quests: readonly T[],
  statuses: Readonly<Record<string, OwnedStatus>>,
  grantedAt: ReadonlyMap<string, string>,
): T[] {
  const key = (q: T) => {
    const s = statuses[q.quest_id] ?? FRESH_STATUS;
    const when = s.state === 'new' ? (grantedAt.get(q.quest_id) ?? '￿') : (s.lastActivity ?? '');
    return { rank: RANK[s.state], when };
  };
  return quests
    .map((q, i) => ({ q, i, k: key(q) }))
    .sort((a, b) => a.k.rank - b.k.rank || b.k.when.localeCompare(a.k.when) || a.i - b.i)
    .map((e) => e.q);
}

export interface InProgress {
  questId: string;
  /** From the downloaded snapshot; null when nothing of it is on the device. */
  name: string | null;
  /** A bundle is on the device, so it opens offline. */
  downloaded: boolean;
}

/** The quest the player was in the middle of most recently — the hero's «Продолжить». */
export async function latestInProgress(): Promise<InProgress | null> {
  let best: { attempt: AttemptRow; at: string } | null = null;
  for (const attempt of await listAttempts()) {
    if (attempt.status !== 'active') continue;
    const rows = await getFacts(attempt.attempt_key);
    if (completion(rows.map((r) => r.fact))) continue;
    if (rows.length === 0 && attempt.last_step_idx === 0) continue;
    const at = rows[rows.length - 1]?.queued_at ?? attempt.created_at;
    if (!best || at > best.at) best = { attempt, at };
  }
  if (!best) return null;
  const { quest_id: questId, snapshot_id } = best.attempt;
  const bundle = (await getBundle(snapshot_id)) ?? (await getLatestBundleForQuest(questId));
  return { questId, name: bundle?.snapshot.name ?? null, downloaded: !!bundle };
}
