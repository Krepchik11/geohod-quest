/**
 * QR invitations, the guest's side. A QR opens
 * `/go/<slug>`, which lands on the quest page with `?promo=<code>`; the page
 * prices the code through the ordinary preview (`api.validateCoupon`) and
 * gives the quest through the ordinary checkout. This module holds the pure
 * parts — the line a refused invitation shows, the free quest an ended one
 * points to — and the per-tab memory of a code not used yet, so a detour
 * (signing in, another page) does not lose the gift.
 */
import type { PublishedQuestWire, RedeemReject } from './api';
import { dottedDay } from './ru';

/** The quest page's query parameter carrying an invitation's code. */
export const PROMO_PARAM = 'promo';

const STORE_PREFIX = 'geohod-promo:v1:';

/**
 * Remember an invitation's code for this quest until it is used. Per tab
 * (sessionStorage): the invitation travels with the visit, not the device.
 */
export function rememberPromo(questId: string, code: string): void {
  try {
    window.sessionStorage.setItem(STORE_PREFIX + questId, code);
  } catch {
    // storage blocked — the code lives as long as the page does
  }
}

/** The code remembered for this quest, or null. */
export function pendingPromo(questId: string): string | null {
  try {
    return window.sessionStorage.getItem(STORE_PREFIX + questId);
  } catch {
    return null;
  }
}

/** Forget the quest's code — the quest is the guest's, or the code is spent. */
export function forgetPromo(questId: string): void {
  try {
    window.sessionStorage.removeItem(STORE_PREFIX + questId);
  } catch {
    // storage blocked — nothing was remembered
  }
}

/** What the page says when an invitation does not apply. */
export interface PromoNotice {
  text: string;
  /** Over for good — the page then suggests a free quest instead. */
  ended: boolean;
}

/** The line for each refusal (the purchase sheet keeps the server's wording). */
export function promoNotice(reason: RedeemReject): PromoNotice {
  switch (reason) {
    case 'paused':
      return { text: 'Приглашение временно не действует', ended: false };
    case 'per_user_limit':
      return { text: 'Вы уже использовали это приглашение', ended: false };
    case 'not_applicable':
      return { text: 'Приглашение не действует на этот квест', ended: false };
    case 'expired':
    case 'exhausted':
    case 'not_found':
      return { text: 'Приглашение закончилось', ended: true };
  }
}

/**
 * The free quest an ended invitation points to: the most played free quest
 * of the same city (in Нови-Сад, «Тайна крепости»), never this quest; null
 * when the city has none.
 */
export function freeAlternative(
  catalog: readonly PublishedQuestWire[],
  city: string | null,
  questId: string,
): PublishedQuestWire | null {
  if (!city) return null;
  let best: PublishedQuestWire | null = null;
  for (const q of catalog) {
    if (q.quest_id === questId || q.city !== city || q.price !== 0) continue;
    if (!best || q.players > best.players) best = q;
  }
  return best;
}

/** «Приглашение действует до 30.11.2026»; null for an invitation without an end date. */
export function giftUntilLabel(validUntil: string | null): string | null {
  return validUntil ? `Приглашение действует до ${dottedDay(validUntil)}` : null;
}
