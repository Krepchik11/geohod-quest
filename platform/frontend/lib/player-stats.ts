/**
 * Player profile statistics — the local mirror of the backend's cross-attempt
 * fold (facts::project_player_stats) plus the merge the profile page uses.
 *
 * Why this exists: the profile tiles (coins / rating / quests completed) must
 * reflect the ACTUAL situation, which for an offline-first player lives in the
 * IndexedDB fact log first and only reaches the server on flush. Reading the
 * server alone shows zeros whenever a completion has not synced yet (the common
 * case right after finishing a quest). So the page folds local facts as the
 * immediate truth and merges the server's authoritative cross-device aggregate
 * on top of it.
 *
 * The fold MUST match the backend's semantics so the two agree once synced:
 *  - balance is the signed sum of coins_delta across ALL of a player's attempts;
 *  - the once-ever bonuses (completion, rating, comment — isOncePerQuest)
 *    are counted at most ONCE per quest, because the server dedups them
 *    once-per-(player, quest) at append time — locally each replayed attempt
 *    still carries its own bonus facts, so we collapse them here;
 *  - gifts re-earned on a replay DO count per attempt (so they are summed, not
 *    deduped) — again matching the server, which keeps one gift_claimed per
 *    attempt;
 *  - a quest counts as completed when ANY of its attempts holds attempt_completed.
 */
import { isOncePerQuest, type Fact, type OncePerQuestType } from './shared-model';
import type { QuestBonusesWire } from './generated/QuestBonusesWire';
import { getFacts, listAttempts } from './queue';

/** One attempt's fact log tagged with its quest — the fold's input unit. */
export interface AttemptLog {
  quest_id: string;
  facts: Fact[];
  /** ISO date the attempt started (profile shows it as the completion date). */
  created_at?: string;
}

/** The minimal stats shape shared by the local fold and the server response. */
export interface PlayerStatsFold {
  balance: number;
  completed_quest_ids: string[];
}

/** What the profile tiles render, after merging local truth with the server. */
export interface ProfileStats {
  balance: number;
  completedIds: string[];
}

/**
 * Pure cross-attempt fold over local logs — mirrors backend project_player_stats.
 * Order-independent; the completed list is sorted. Completion bonus is collapsed
 * to once per quest (see module doc) so local balance equals server balance once
 * the same facts have synced.
 */
export function foldLocalPlayerStats(logs: AttemptLog[]): PlayerStatsFold {
  const factsByQuest = new Map<string, Fact[]>();
  for (const { quest_id, facts } of logs) {
    const acc = factsByQuest.get(quest_id);
    if (acc) acc.push(...facts);
    else factsByQuest.set(quest_id, [...facts]);
  }

  let balance = 0;
  const completed: string[] = [];
  for (const [quest_id, facts] of factsByQuest) {
    const counted = new Set<OncePerQuestType>();
    for (const f of facts) {
      if (isOncePerQuest(f.type)) {
        if (counted.has(f.type)) continue; // once-per-quest, matching the server
        counted.add(f.type);
      }
      balance += f.coins_delta || 0;
    }
    if (facts.some((f) => f.type === 'attempt_completed')) completed.push(quest_id);
  }
  completed.sort();
  return { balance, completed_quest_ids: completed };
}

/**
 * The server's answer, read as kinds this client understands. The wire carries
 * plain strings — a build that does not know a kind must drop it rather than
 * hand the engine something it cannot act on.
 */
export function serverQuestBonuses(answer: QuestBonusesWire | null): OncePerQuestType[] {
  return (answer?.kinds ?? []).filter(isOncePerQuest);
}

/**
 * What this quest has already paid the player — the engine's input for the same
 * rule (`PlayCtx.earnedBonuses`). Two sources, one answer: this device's logs,
 * which the wallet also folds so the two cannot disagree (issue #114), and what
 * the server knows from every other device (issue #117).
 */
export function earnedQuestBonuses(
  logs: AttemptLog[],
  questId: string,
  paidElsewhere: readonly OncePerQuestType[] = [],
): Set<OncePerQuestType> {
  const earned = new Set<OncePerQuestType>(paidElsewhere);
  for (const log of logs) {
    if (log.quest_id !== questId) continue;
    for (const f of log.facts) if (isOncePerQuest(f.type)) earned.add(f.type);
  }
  return earned;
}

/** One log per stored attempt (active AND superseded), minus `exceptKey`. The
 *  reads are independent, so they run together rather than one attempt at a
 *  time — this sits on the player's mount path. */
async function gatherAttemptLogs(exceptKey: string | null): Promise<AttemptLog[]> {
  const attempts = (await listAttempts()).filter((a) => a.attempt_key !== exceptKey);
  return Promise.all(
    attempts.map(async (a) => ({
      quest_id: a.quest_id,
      facts: (await getFacts(a.attempt_key)).map((r) => r.fact),
      created_at: a.created_at,
    })),
  );
}

/** Gather one log per attempt (active AND superseded) straight from the queue. */
export function gatherLocalAttemptLogs(): Promise<AttemptLog[]> {
  return gatherAttemptLogs(null);
}

/** §7.2 — per-quest completion details: date of the completing attempt and the
 *  player's own finale rating from that attempt's log (0 = «без оценки»). */
export interface CompletedQuestDetail {
  quest_id: string;
  completed_at: string | null;
  rating: number;
}

export function completedQuestDetails(logs: AttemptLog[]): Record<string, CompletedQuestDetail> {
  const out: Record<string, CompletedQuestDetail> = {};
  for (const log of logs) {
    if (!log.facts.some((f) => f.type === 'attempt_completed')) continue;
    const rated = [...log.facts].reverse().find((f) => f.type === 'quest_rated');
    const rating = rated ? Math.max(0, Math.min(5, Math.round(Number(rated.submitted_value) || 0))) : 0;
    // Newest completing attempt wins (a replay updates the date and rating).
    const prev = out[log.quest_id];
    if (!prev || (log.created_at ?? '') >= (prev.completed_at ?? '')) {
      out[log.quest_id] = {
        quest_id: log.quest_id,
        completed_at: log.created_at ?? null,
        rating,
      };
    }
  }
  return out;
}

/**
 * Gather every attempt's log EXCEPT the given active one — the prior slice of the
 * cross-quest wallet. The in-play coin display folds these together with the active
 * attempt's LIVE (in-memory) facts, so the wallet stays correct as the player earns
 * and spends without re-reading the active attempt's possibly-stale stored copy.
 * Passing a null key returns every attempt (no active attempt yet).
 */
export function gatherOtherAttemptLogs(activeKey: string | null): Promise<AttemptLog[]> {
  return gatherAttemptLogs(activeKey);
}

/**
 * Merge the server's authoritative aggregate with the device-local fold.
 *
 * - completed quests: the UNION — a quest the user finished is shown whether the
 *   server has heard about it yet or not (never under-reports a real completion).
 * - balance: max(server, local). Local is the exact fold of THIS device's facts,
 *   so it is never an over-count; the server may legitimately be higher when
 *   another device contributed coins. Taking the max therefore surfaces whichever
 *   source is more complete without ever double-counting synced facts (a fact the
 *   server already has is also in local, so the two overlap rather than add).
 *
 * When the server is unreachable (null), the local fold stands alone.
 */
export function mergeProfileStats(
  server: PlayerStatsFold | null,
  local: PlayerStatsFold,
): ProfileStats {
  if (!server) {
    return { balance: local.balance, completedIds: local.completed_quest_ids };
  }
  const completedIds = [
    ...new Set([...server.completed_quest_ids, ...local.completed_quest_ids]),
  ].sort();
  return { balance: Math.max(server.balance, local.balance), completedIds };
}
