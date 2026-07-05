'use client';

import React, { useState } from 'react';
import Link from 'next/link';
import { api, type PublishedQuestWire } from '../../lib/api';
import { currentPlayerId } from '../../lib/identity';
import { coverCss } from '../../lib/cover';
import { downloadBundle } from '../../lib/download';
import { fmtRating, priceLabel, ratingPlural } from '../../lib/storefront';
import PurchaseSheet from './PurchaseSheet';

/**
 * §2.1/§2.2 shop card v2. Cover, title and «О квесте и отзывы →» route to the
 * product page — nothing on the card opens the player except the owned CTA.
 * All purchase status lives IN the card: pending spinner on the button, success
 * in the price slot, a red line under the price row on failure. Paid quests go
 * through the confirmation sheet; free quests grant instantly.
 */
export default function QuestCard({
  quest,
  owned: ownedProp,
}: {
  quest: PublishedQuestWire;
  owned: boolean;
}) {
  const [sheetOpen, setSheetOpen] = useState(false);
  const [state, setState] = useState<'idle' | 'pending' | 'error'>('idle');
  // «куплен только что»: the card flips in place after a grant (§3.4).
  const [justBought, setJustBought] = useState(false);
  const owned = ownedProp || justBought;

  const aboutUrl = `/quest/${encodeURIComponent(quest.quest_id)}/about`;
  const playUrl = `/quest/${encodeURIComponent(quest.quest_id)}`;
  const free = quest.price === 0;

  // §3.4/§4.2: silent offline auto-download right after a successful grant.
  const autoDownload = () => {
    void downloadBundle(quest.quest_id, currentPlayerId(), api).catch(() => {
      /* silent: the My Quests row offers a visible retry */
    });
  };

  const grantFree = async () => {
    setState('pending');
    try {
      await api.checkout({ player_id: currentPlayerId(), quest_id: quest.quest_id });
      setJustBought(true);
      setState('idle');
      autoDownload();
    } catch {
      setState('error');
    }
  };

  const onPurchased = () => {
    setSheetOpen(false);
    setJustBought(true);
    setState('idle');
    autoDownload();
  };

  return (
    <article className="quest-card card">
      <Link className="quest-card__photo" href={aboutUrl} style={{ backgroundImage: coverCss(quest.primary_comic) }}>
        {!quest.primary_comic && <span className="qmark">?</span>}
        {owned && <span className="quest-card__owned-badge">✓ Куплен</span>}
      </Link>
      <div className="quest-card__body">
        {(quest.city || quest.duration) && (
          <p className="quest-card__meta">
            {quest.city && (
              <span><span className="ic" style={{ '--ic': "url('/assets/icons/c/ic-pin--navy.svg')" } as React.CSSProperties} />{quest.city}</span>
            )}
            {quest.duration && (
              <span><span className="ic" style={{ '--ic': "url('/assets/icons/c/ic-clock-ring--navy.svg')" } as React.CSSProperties} />{quest.duration}</span>
            )}
          </p>
        )}
        <h3 className="quest-card__title"><Link href={aboutUrl}>{quest.name}</Link></h3>
        {quest.rating_count > 0 ? (
          <p className="rating quest-card__rating">
            <span className="ic" /><b>{fmtRating(quest.rating_avg)}</b>
            <span className="muted">({quest.rating_count}&nbsp;{ratingPlural(quest.rating_count)})</span>
          </p>
        ) : (
          <p className="rating quest-card__rating"><span className="muted">Нет оценок</span></p>
        )}
        <Link className="quest-card__about" href={aboutUrl}>О квесте и отзывы →</Link>
        <hr className="quest-card__divider" />
        <div className="quest-card__footer">
          {owned ? (
            <>
              <span className="quest-card__price quest-card__price--owned">
                {justBought ? '✓ Квест в «Моих квестах»' : 'Куплен'}
              </span>
              <Link className="btn quest-card__cta" href={playUrl}>Пройти</Link>
            </>
          ) : (
            <>
              <span className="quest-card__price">{priceLabel(quest.price)}</span>
              {state === 'pending' ? (
                <button className="btn quest-card__cta is-pending" type="button" disabled>
                  <span className="psheet__spinner" aria-hidden />
                  Оформляем…
                </button>
              ) : (
                <button
                  className="btn quest-card__cta"
                  type="button"
                  onClick={() => (free ? void grantFree() : setSheetOpen(true))}
                >
                  {free ? 'Получить' : 'Купить'}
                </button>
              )}
            </>
          )}
        </div>
        {state === 'error' && (
          <p className="quest-card__error">Не получилось оформить покупку — попробуйте ещё раз.</p>
        )}
      </div>

      {sheetOpen && (
        <PurchaseSheet
          quest={quest}
          onClose={() => setSheetOpen(false)}
          onPurchased={onPurchased}
        />
      )}
    </article>
  );
}
