'use client';

import { useEffect, useState } from 'react';
import { api, type CouponVerdict, type PublishedQuestWire } from '../../../../lib/api';
import { currentUserId } from '../../../../lib/identity';
import {
  PROMO_PARAM,
  forgetPromo,
  freeAlternative,
  pendingPromo,
  promoNotice,
  rememberPromo,
  type PromoNotice,
} from '../../../../lib/promo';

/** A QR invitation as the quest page shows it. */
export type PromoInvite =
  /** No invitation, or not priced yet. */
  | { kind: 'none' }
  /** The invitation applies: `finalPrice` 0 is a gift, more is a discount. */
  | {
      kind: 'offer';
      code: string;
      price: number;
      finalPrice: number;
      validUntil: string | null;
      giftFrom: string | null;
    }
  /** It does not apply; an ended one may point to a free quest of the city. */
  | { kind: 'refused'; notice: PromoNotice; alternative: Pick<PublishedQuestWire, 'quest_id' | 'name'> | null };

const NONE: PromoInvite = { kind: 'none' };

/**
 * The QR invitation on the quest page (flag `promo_qr`). The code arrives as
 * `?promo=` — remembered for this tab and dropped from the address bar, like
 * the page's other one-shot params — or was remembered on an earlier visit in
 * this tab. It is priced by the server preview once `ready` (the flag is on,
 * the quest is paid, the guest does not own it yet); nothing is spent until
 * checkout. `forget` drops the code once the quest is the guest's; `recheck`
 * prices it again (it may have run out since).
 */
export function usePromoInvite(
  questId: string,
  { ready, city }: { ready: boolean; city: string | null },
): { invite: PromoInvite; forget: () => void; recheck: () => void } {
  const [code, setCode] = useState<string | null>(() =>
    typeof window === 'undefined'
      ? null
      : new URLSearchParams(window.location.search).get(PROMO_PARAM) ?? pendingPromo(questId),
  );
  const [verdict, setVerdict] = useState<CouponVerdict | null>(null);
  const [alternative, setAlternative] = useState<Pick<PublishedQuestWire, 'quest_id' | 'name'> | null>(null);
  // Bumped by `recheck`: the same code priced again.
  const [round, setRound] = useState(0);

  // The code is kept for this tab, the address bar loses it — a reload or a
  // shared link must not carry it further than the QR did.
  useEffect(() => {
    if (!code) return;
    rememberPromo(questId, code);
    const params = new URLSearchParams(window.location.search);
    if (!params.has(PROMO_PARAM)) return;
    params.delete(PROMO_PARAM);
    const query = params.toString();
    window.history.replaceState(null, '', `${window.location.pathname}${query ? `?${query}` : ''}`);
  }, [code, questId]);

  useEffect(() => {
    if (!ready || !code) return;
    let cancelled = false;
    api
      .validateCoupon({ user_id: currentUserId(), quest_id: questId, code })
      .then((v) => {
        if (!cancelled) setVerdict(v);
      })
      .catch(() => {
        /* no verdict — the page sells as usual, the code waits for a reload */
      });
    return () => {
      cancelled = true;
    };
  }, [ready, code, questId, round]);

  const ended = verdict?.valid === false && promoNotice(verdict.reason).ended;
  useEffect(() => {
    if (!ended) return;
    let cancelled = false;
    api
      .listQuests()
      .then((catalog) => {
        if (!cancelled) setAlternative(freeAlternative(catalog, city, questId));
      })
      .catch(() => {
        /* no suggestion — the notice still stands */
      });
    return () => {
      cancelled = true;
    };
  }, [ended, city, questId]);

  const forget = () => {
    forgetPromo(questId);
    setCode(null);
    setVerdict(null);
  };
  const recheck = () => setRound((n) => n + 1);

  if (!ready || !code || !verdict) return { invite: NONE, forget, recheck };
  const invite: PromoInvite = verdict.valid
    ? {
        kind: 'offer',
        code: verdict.code,
        price: verdict.price,
        finalPrice: verdict.final_price,
        validUntil: verdict.valid_until,
        giftFrom: verdict.gift_from,
      }
    : { kind: 'refused', notice: promoNotice(verdict.reason), alternative };
  return { invite, forget, recheck };
}
