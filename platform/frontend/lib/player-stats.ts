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
 *  - the completion bonus is counted at most ONCE per quest, because the server
 *    dedups it once-per-(player, quest) at append time — locally each replayed
 *    attempt still carries its own bonus fact, so we collapse them here;
 *  - gifts re-earned on a replay DO count per attempt (so they are summed, not
 *    deduped) — again matching the server, which keeps one gift_claimed per
 *    attempt;
 *  - a quest counts as completed when ANY of its attempts holds attempt_completed.
 */
import type { Fact } from './shared-model';
import { getFacts, listAttempts } from './queue';

/** One attempt's fact log tagged with its quest — the fold's input unit. */
export interface AttemptLog {
  quest_id: string;
  facts: Fact[];
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
    let bonusCounted = false;
    for (const f of facts) {
      if (f.type === 'completion_bonus') {
        if (bonusCounted) continue; // once-per-quest, matching the server
        bonusCounted = true;
      }
      balance += f.coins_delta || 0;
    }
    if (facts.some((f) => f.type === 'attempt_completed')) completed.push(quest_id);
  }
  completed.sort();
  return { balance, completed_quest_ids: completed };
}

/** Gather one log per attempt (active AND superseded) straight from the queue. */
export async function gatherLocalAttemptLogs(): Promise<AttemptLog[]> {
  const attempts = await listAttempts();
  const logs: AttemptLog[] = [];
  for (const a of attempts) {
    const facts = (await getFacts(a.attempt_key)).map((r) => r.fact);
    logs.push({ quest_id: a.quest_id, facts });
  }
  return logs;
}

/**
 * Gather every attempt's log EXCEPT the given active one — the prior slice of the
 * cross-quest wallet. The in-play coin display folds these together with the active
 * attempt's LIVE (in-memory) facts, so the wallet stays correct as the player earns
 * and spends without re-reading the active attempt's possibly-stale stored copy.
 * Passing a null key returns every attempt (no active attempt yet).
 */
export async function gatherOtherAttemptLogs(activeKey: string | null): Promise<AttemptLog[]> {
  const attempts = await listAttempts();
  const logs: AttemptLog[] = [];
  for (const a of attempts) {
    if (a.attempt_key === activeKey) continue;
    const facts = (await getFacts(a.attempt_key)).map((r) => r.fact);
    logs.push({ quest_id: a.quest_id, facts });
  }
  return logs;
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
