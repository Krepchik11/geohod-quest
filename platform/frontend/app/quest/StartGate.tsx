'use client';

import React from 'react';
import { PCoin } from '../player/PlayerComponents';

/**
 * §8.2 (4.2) — paper start gate: shown when opening a quest with an
 * in-progress attempt. Rebuilt in the paper language (Prata title, ornament
 * divider, ink buttons, #FFF9F0 stat cards) — no blue site pills inside the
 * player. Restart lives ONLY here (closes 2.1), with the honest «монеты
 * останутся» caption. Presentational: continue/restart are the caller's.
 */
export function StartGate({
  title,
  createdAt,
  pos,
  total,
  coins,
  onContinue,
  onRestart,
}: {
  title: string;
  createdAt: string | null;
  pos: number;
  total: number;
  /** Coins earned so far in this attempt's wallet view. */
  coins: number;
  onContinue: () => void;
  onRestart: () => void;
}) {
  const date = createdAt
    ? new Date(createdAt).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric' })
    : '—';
  return (
    <div className="sg2">
      <p className="sg2__kicker">городской квест</p>
      <h2 className="sg2__title">{title}</h2>
      <div className="sg2__ornament" aria-hidden>
        <i />
        <svg width="34" height="10" viewBox="0 0 34 10"><circle cx="3" cy="5" r="1.4" fill="currentColor" /><polygon points="17,0.5 21.5,5 17,9.5 12.5,5" fill="currentColor" /><circle cx="31" cy="5" r="1.4" fill="currentColor" /></svg>
        <i />
      </div>
      <p className="sg2__note">У вас есть незаконченная попытка</p>
      <div className="sg2__stats">
        <div className="sg2__stat">
          <b>шаг {pos} из {total}</b>
          <span>от {date}</span>
        </div>
        <div className="sg2__stat">
          <b className="with-coin"><PCoin size={16} />{coins}</b>
          <span>монет заработано</span>
        </div>
      </div>
      <div className="sg2__actions">
        <button className="sg2__btn" type="button" onClick={onContinue}>продолжить попытку</button>
        <button className="sg2__btn sg2__btn--outline" type="button" onClick={onRestart}>начать заново</button>
        <p className="sg2__caption">«Начать заново» сбросит прогресс попытки.<br />Заработанные монеты останутся при вас.</p>
      </div>
    </div>
  );
}
