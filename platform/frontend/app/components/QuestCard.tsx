'use client';

import React, { useState } from 'react';
import Link from 'next/link';
import { api, type PublishedQuestWire } from '../../lib/api';
import { markOwned } from '../../lib/collection';
import { currentUserId } from '../../lib/identity';
import { coverCss } from '../../lib/cover';
import { downloadBundle, type DownloadStage } from '../../lib/download';
import { ctaFor, formatDate, FRESH_STATUS, type OwnedStatus } from '../../lib/owned-quests';
import {
  attrsLine,
  fmtRating,
  playerCountPlural,
  priceLabel,
  questFacts,
  ratingPlural,
  showPlayers,
} from '../../lib/storefront';
import PurchaseSheet from './PurchaseSheet';
import RemoveFromDeviceSheet from './RemoveFromDeviceSheet';
import ShareQuestButton from './ShareQuestButton';
import { toast } from './Toaster';
import { useClientFeature } from '../../lib/client-features';

/** store_my_quests: what an own-quest card needs beyond the catalog row. */
export interface MineProps {
  /** This device's view of the quest; null until read (shown as a fresh one). */
  status: OwnedStatus | null;
  /** The shop runs from the offline shelf — nothing can be fetched. */
  offline: boolean;
  /** A download or a removal changed what the device holds: re-read the status. */
  onChange: (questId: string) => void;
  /** The quest became the player's on this card: the page keeps the card where
   *  it is until the next visit instead of moving it from under the finger. */
  onAcquired?: (questId: string) => void;
}

const STATE_LABEL = { new: 'Не начат', progress: 'В процессе', done: 'Пройден' } as const;
const STAGE_WIDTH: Record<DownloadStage, number> = { fetching: 33, storing: 66, caching: 90, done: 100 };

/**
 * §2.1/§2.2 shop card v2. The whole card is a single block link to the product
 * page (the title anchor stretches over the card via ::after) — nothing on the
 * card opens the player except the owned CTA. The CTAs sit above the overlay
 * (z-index) so a click on a button never triggers the card navigation.
 * All purchase status lives IN the card: pending spinner on the button, success
 * in the price slot, a red line under the price row on failure. Paid quests go
 * through the confirmation sheet; free quests grant instantly.
 *
 * With `mine` (store_my_quests) an owned card is the player's own quest: its
 * state on the cover, the step or finish date in the price slot, the one honest
 * CTA, and ONE offline chip on the cover that downloads, updates, completes a
 * partial download, or — once downloaded — opens «Удалить с устройства».
 */
export default function QuestCard({
  quest,
  owned: ownedProp,
  mine,
}: {
  quest: PublishedQuestWire;
  owned: boolean;
  mine?: MineProps;
}) {
  const [sheetOpen, setSheetOpen] = useState(false);
  const shareOn = useClientFeature('quest_share');
  const factsOn = useClientFeature('quest_facts');
  const [state, setState] = useState<'idle' | 'pending' | 'error'>('idle');
  // «куплен только что»: the card flips in place after a grant (§3.4).
  const [justBought, setJustBought] = useState(false);
  const [dl, setDl] = useState<DownloadStage | null>(null);
  const [removeOpen, setRemoveOpen] = useState(false);
  const owned = ownedProp || justBought;

  const aboutUrl = `/quest/${encodeURIComponent(quest.quest_id)}/about`;
  const playUrl = `/quest/${encodeURIComponent(quest.quest_id)}`;
  const free = quest.price === 0;

  // Function declaration (hoisted) so the toast's «Повторить» can re-invoke it.
  // `dl` stays 'done' after success: the card reads as downloaded until the
  // re-read status says so itself.
  async function download() {
    setDl('fetching');
    try {
      await downloadBundle(quest.quest_id, currentUserId(), api, setDl);
      mine?.onChange(quest.quest_id);
    } catch {
      setDl(null);
      toast('Не удалось скачать квест — проверьте связь', { label: 'Повторить', onClick: () => void download() });
    }
  }

  // §3.4/§4.2: offline auto-download right after a successful grant — visible on
  // an own-quest card, silent otherwise (My Quests offers the retry there).
  const autoDownload = () => {
    if (mine) {
      void download();
      return;
    }
    void downloadBundle(quest.quest_id, currentUserId(), api).catch(() => {});
  };

  const grantFree = async () => {
    setState('pending');
    try {
      await api.checkout({ user_id: currentUserId(), quest_id: quest.quest_id });
      setJustBought(true);
      mine?.onAcquired?.(quest.quest_id);
      markOwned(quest.quest_id);
      setState('idle');
      toast('Квест ваш — можно начинать');
      autoDownload();
    } catch {
      setState('error');
    }
  };

  const onPurchased = () => {
    setSheetOpen(false);
    setJustBought(true);
    mine?.onAcquired?.(quest.quest_id);
    markOwned(quest.quest_id);
    setState('idle');
    autoDownload();
  };

  const own = !!mine && owned;
  const offline = mine?.offline ?? false;
  const status = mine?.status ?? FRESH_STATUS;
  const busy = dl !== null && dl !== 'done';
  const downloaded = !!status.bundle || dl === 'done';
  const partial = status.bundle?.media_complete === false && dl !== 'done';
  const share = shareOn && !offline && (
    <ShareQuestButton variant="icon" quest={{ questId: quest.quest_id, name: quest.name, city: quest.city }} />
  );

  let chip: React.ReactNode = null;
  if (busy) {
    chip = (
      <span className="quest-card__dl is-busy" role="status">
        <span className="psheet__spinner" aria-hidden />
        Скачиваем…
      </span>
    );
  } else if (!downloaded) {
    chip = !offline && (
      <button className="quest-card__dl" type="button" onClick={() => void download()} aria-label="Скачать для офлайна">
        ⭳ Скачать
      </button>
    );
  } else if (!offline && (status.updateAvailable || partial) && dl !== 'done') {
    chip = (
      <button className="quest-card__dl" type="button" onClick={() => void download()}>
        {status.updateAvailable ? 'Обновить' : '⭳ Докачать'}
      </button>
    );
  } else {
    chip = (
      <button
        className="quest-card__dl quest-card__dl--ready"
        type="button"
        onClick={() => setRemoveOpen(true)}
        aria-label="Скачан для офлайна. Удалить с устройства"
      >
        {partial ? '⭳ частично' : '⭳ офлайн'}
      </button>
    );
  }

  const facts = questFacts(quest, factsOn);
  const attrs = attrsLine(quest);

  const progress = status.state === 'progress' && status.pos && status.total ? (status.pos / status.total) * 100 : null;
  const strip = busy && dl ? STAGE_WIDTH[dl] : progress;

  let mineLine = 'Куплен';
  if (justBought) mineLine = '✓ Квест ваш';
  else if (status.state === 'progress') mineLine = status.total ? `шаг ${status.pos} из ${status.total}` : `шаг ${status.pos}`;
  else if (status.state === 'done') mineLine = `пройден ${formatDate(status.lastActivity)}`.trim();

  const cta = ctaFor(status.state);
  const ctaHref = cta.restart ? `${playUrl}?restart=1` : playUrl;
  const ctaClass = `btn quest-card__cta quest-card__cta--mine${cta.variant === 'secondary' ? ' btn--secondary' : ''}`;

  return (
    <article className="quest-card card">
      <div className="quest-card__photo" style={{ backgroundImage: coverCss(quest.primary_comic) }}>
        {!quest.primary_comic && <span className="qmark">?</span>}
        {own ? (
          <>
            <span className={`quest-card__state quest-card__state--${status.state}`}>{STATE_LABEL[status.state]}</span>
            {chip}
            {strip !== null && (
              <span className="quest-card__strip" aria-hidden><i style={{ width: `${strip}%` }} /></span>
            )}
          </>
        ) : owned ? (
          <span className="quest-card__owned-badge">✓ Куплен</span>
        ) : (
          free && <span className="quest-card__free">Бесплатно</span>
        )}
      </div>
      <div className="quest-card__body">
        {(quest.city || facts.time || facts.distance) && (
          <p className="quest-card__meta">
            {quest.city && <span><span className="ic ic-pin" />{quest.city}</span>}
            {facts.time && <span><span className="ic ic-clock" />{facts.time}</span>}
            {facts.distance && <span><span className="ic ic-route" />{facts.distance}</span>}
          </p>
        )}
        <h3 className="quest-card__title">
          <Link className="quest-card__link" href={aboutUrl}>{quest.name}</Link>
        </h3>
        {attrs && <p className="quest-card__attrs">{attrs}</p>}
        {quest.rating_count > 0 ? (
          <p className="rating quest-card__rating">
            <span className="ic" /><b>{fmtRating(quest.rating_avg)}</b>
            <span className="muted">
              {quest.rating_count}&nbsp;{ratingPlural(quest.rating_count)}
              {showPlayers(quest.players, quest.rating_count) &&
                ` · ${quest.players} ${playerCountPlural(quest.players)}`}
            </span>
          </p>
        ) : (
          <p className="rating quest-card__rating"><span className="muted">Нет оценок</span></p>
        )}
        <hr className="quest-card__divider" />
        <div className="quest-card__footer">
          {own ? (
            <>
              <span className={`quest-card__mine${status.state === 'done' ? ' quest-card__mine--done' : ''}`}>{mineLine}</span>
              {offline && !downloaded ? (
                <button className="btn quest-card__cta quest-card__cta--mine" type="button" disabled>Нужна сеть</button>
              ) : offline ? (
                // Offline the client router cannot fetch the page — a real
                // navigation lets the service worker serve the cached player.
                <a className={ctaClass} href={ctaHref}>{cta.label}</a>
              ) : (
                <Link className={ctaClass} href={ctaHref}>{cta.label}</Link>
              )}
              {share}
            </>
          ) : owned ? (
            <>
              <span className="quest-card__price quest-card__price--owned">
                {justBought ? '✓ Квест в «Моих квестах»' : 'Куплен'}
              </span>
              <Link className="btn quest-card__cta" href={playUrl}>Играть</Link>
              {share}
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
              {/* Above the card's stretched title overlay (z-index in .share-ico),
                  and the handler stops the click from reaching it. */}
              {share}
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
      {removeOpen && (
        <RemoveFromDeviceSheet
          questId={quest.quest_id}
          name={quest.name}
          onClose={() => setRemoveOpen(false)}
          onRemoved={() => {
            setRemoveOpen(false);
            setDl(null);
            mine?.onChange(quest.quest_id);
          }}
        />
      )}
    </article>
  );
}
