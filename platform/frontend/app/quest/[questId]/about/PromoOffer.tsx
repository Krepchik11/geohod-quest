import React from 'react';
import Link from 'next/link';
import { giftUntilLabel } from '../../../../lib/promo';
import type { PromoInvite } from './usePromoInvite';

/**
 * The QR invitation's price block (flag `promo_qr`): «Квест в подарок» with
 * the old price struck through and 0 ₽ — or, for a partial discount, the
 * discounted price — plus who gives it and until when. The plain promise
 * under a gift answers the guest's first fear: nothing to pay, ever.
 */
export function GiftOffer({ offer }: { offer: Extract<PromoInvite, { kind: 'offer' }> }) {
  const gift = offer.finalPrice === 0;
  const until = giftUntilLabel(offer.validUntil);
  return (
    <div className="qp-gift">
      <b className="qp-gift__title">{gift ? 'Квест в подарок' : 'Скидка по приглашению'}</b>
      {offer.giftFrom && (
        <span className="qp-gift__from">
          {gift ? 'Подарок' : 'Приглашение'} от {offer.giftFrom}
        </span>
      )}
      <span className="qp-gift__price">
        <s>{offer.price} ₽</s>
        <b>{offer.finalPrice} ₽</b>
      </span>
      {gift && <span className="qp-gift__note">Без карты и подписки — квест ваш навсегда.</span>}
      {until && <span className="qp-gift__note">{until}</span>}
    </div>
  );
}

/**
 * Why the invitation does not apply. The page around it sells the quest as
 * usual — not a dead end — and an ended invitation also points to a free
 * quest of the same city.
 */
export function PromoNoticeLine({ invite }: { invite: Extract<PromoInvite, { kind: 'refused' }> }) {
  const { notice, alternative } = invite;
  return (
    <div className="qp-promo-note" role="status">
      <b>{notice.text}</b>
      {notice.ended && alternative && (
        <span>
          Попробуйте бесплатный квест{' '}
          <Link href={`/quest/${encodeURIComponent(alternative.quest_id)}/about`}>«{alternative.name}»</Link>
        </span>
      )}
    </div>
  );
}
