'use client';

import React, { useState, useSyncExternalStore } from 'react';
import Link from 'next/link';
import { api } from '../../lib/api';
import { currentPlayerId, getSession, subscribeSession } from '../../lib/identity';
import { coverCss } from '../../lib/cover';

/**
 * §3.3 purchase confirmation sheet — bottom sheet on mobile, centered 440px
 * modal on desktop (same DOM; CSS switches). Opened by «Купить» from a shop
 * card (fast-path) or the product page order card.
 *
 * Charging happens ONLY on «Подтвердить», via the existing api.checkout. The
 * promo field is validated SERVER-SIDE against the admin coupon registry
 * (api.validateCoupon — never consumes); checkout then carries the code and
 * the backend applies the same discount atomically against the coupon's caps.
 */
export interface PurchaseSheetQuest {
  quest_id: string;
  name: string;
  city: string | null;
  duration: string | null;
  price: number | null;
  primary_comic: string | null;
}

/** A server-confirmed promo: what the registry priced for THIS quest. */
interface AppliedPromo {
  code: string;
  discountAmount: number;
  finalPrice: number;
}

export default function PurchaseSheet({
  quest,
  onClose,
  onPurchased,
}: {
  quest: PurchaseSheetQuest;
  onClose: () => void;
  /** §3.4: the caller flips its card to the owned state in place — no redirect. */
  onPurchased: () => void;
}) {
  const session = useSyncExternalStore(subscribeSession, getSession, () => null);
  const [promoOpen, setPromoOpen] = useState(false);
  const [promoCode, setPromoCode] = useState('');
  const [applied, setApplied] = useState<AppliedPromo | null>(null);
  const [promoError, setPromoError] = useState<string | null>(null);
  const [promoChecking, setPromoChecking] = useState(false);
  const [state, setState] = useState<'idle' | 'pending' | 'error'>('idle');

  const price = quest.price ?? 0;
  const finalPrice = applied ? applied.finalPrice : price;
  const metaLine = [quest.city, quest.duration, 'доступ навсегда'].filter(Boolean).join(' · ');

  const confirm = async () => {
    setState('pending');
    try {
      await api.checkout({
        player_id: currentPlayerId(),
        quest_id: quest.quest_id,
        ...(applied ? { coupon_code: applied.code } : {}),
      });
      onPurchased();
    } catch {
      setState('error');
    }
  };

  const applyPromo = async () => {
    const code = promoCode.trim();
    if (!code) {
      setApplied(null);
      setPromoError(null);
      return;
    }
    setPromoChecking(true);
    try {
      const verdict = await api.validateCoupon({
        player_id: currentPlayerId(),
        quest_id: quest.quest_id,
        code,
      });
      if (verdict.valid) {
        setApplied({
          code: verdict.code,
          discountAmount: verdict.discount_amount,
          finalPrice: verdict.final_price,
        });
        setPromoError(null);
      } else {
        setApplied(null);
        setPromoError(verdict.message);
      }
    } catch {
      setApplied(null);
      setPromoError('Не удалось проверить промокод — попробуйте ещё раз.');
    } finally {
      setPromoChecking(false);
    }
  };

  return (
    <div className="psheet__ovl" onClick={state === 'pending' ? undefined : onClose}>
      <div className="psheet" role="dialog" aria-label="Подтвердите покупку" onClick={(e) => e.stopPropagation()}>
        <span className="psheet__grabber" aria-hidden />
        <h3 className="psheet__title">Подтвердите покупку</h3>

        <div className="psheet__quest">
          <span className="psheet__thumb" style={{ backgroundImage: coverCss(quest.primary_comic) }} />
          <span className="psheet__quest-body">
            <b>{quest.name}</b>
            <span>{metaLine}</span>
          </span>
        </div>

        <div className="psheet__price">
          <span>К оплате</span>
          <b>{finalPrice} ₽</b>
        </div>

        {!promoOpen ? (
          <button className="psheet__promo-link" type="button" onClick={() => setPromoOpen(true)}>
            Есть промокод?
          </button>
        ) : (
          <>
            <div className="psheet__promo">
              <input
                className="input"
                placeholder="Промокод"
                value={promoCode}
                onChange={(e) => setPromoCode(e.target.value)}
                disabled={state === 'pending' || promoChecking}
              />
              <button
                className="btn btn--secondary btn--md"
                type="button"
                onClick={() => void applyPromo()}
                disabled={state === 'pending' || promoChecking}
              >
                {promoChecking ? 'Проверяем…' : 'Применить'}
              </button>
            </div>
            {promoError && <div className="psheet__error">{promoError}</div>}
            {applied != null && (
              <div className="psheet__discount">
                <span>Промокод −{applied.discountAmount} ₽</span>
                <span><s>{price} ₽</s> <b>{finalPrice} ₽</b></span>
              </div>
            )}
          </>
        )}

        {!session && (
          <div className="psheet__warn">
            <span aria-hidden>⚠</span>
            <span>
              Вы не вошли: покупка привяжется к этому устройству и потеряется при смене браузера.{' '}
              <Link href="/auth">Войти</Link>
            </span>
          </div>
        )}

        {state === 'error' && (
          <div className="psheet__error">Не получилось оформить покупку — проверьте связь и попробуйте ещё раз.</div>
        )}

        {state === 'pending' ? (
          <button className="btn btn--block psheet__confirm is-pending" type="button" disabled>
            <span className="psheet__spinner" aria-hidden />
            Оформляем покупку…
          </button>
        ) : (
          <button className="btn btn--block psheet__confirm" type="button" onClick={() => void confirm()}>
            {state === 'error' ? `Повторить — ${finalPrice} ₽` : `Подтвердить — ${finalPrice} ₽`}
          </button>
        )}
        <button className="psheet__cancel" type="button" onClick={onClose} disabled={state === 'pending'}>
          Отмена
        </button>
      </div>
    </div>
  );
}
