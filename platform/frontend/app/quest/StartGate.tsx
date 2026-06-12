'use client';

import React from 'react';

/**
 * Start gate (SPEC «Start gate», design/myquests/screens.jsx StartGate):
 * shown when opening a quest with an in-progress attempt — cover, attempt
 * summary, [Продолжить попытку] / [Начать заново] + «монеты останутся» note.
 * Classes (.sg-*, s-btn, co-row, mq-progressline) are ported in myquests.css.
 */
export function StartGate({
  title,
  cover,
  createdAt,
  pos,
  total,
  version,
  onContinue,
  onRestart,
}: {
  title: string;
  cover: string | null;
  createdAt: string | null;
  pos: number;
  total: number;
  version: number;
  onContinue: () => void;
  onRestart: () => void;
}) {
  const date = createdAt
    ? new Date(createdAt).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric' })
    : '—';
  return (
    <div className="sg-body" style={{ maxWidth: 360, margin: '0 auto' }}>
      <div
        className="sg-cover"
        style={{ backgroundImage: cover ? `url(${cover})` : undefined, backgroundColor: cover ? undefined : 'var(--navy)' }}
      >
        {!cover && <span className="qmark">?</span>}
      </div>
      <h2 className="co-title" style={{ fontSize: '17px' }}>{title}</h2>
      <div className="sg-attempt">
        <div className="co-row"><span className="lbl">Текущая попытка</span><span>от {date}</span></div>
        <div className="co-row"><span className="lbl">Прогресс</span><span>шаг {pos} из {total}</span></div>
        <div className="co-row"><span className="lbl">Версия квеста</span><span>{version}</span></div>
        <div className="mq-progressline"><i style={{ width: `${Math.round((pos / Math.max(total, 1)) * 100)}%` }} /></div>
      </div>
      <button className="s-btn s-btn--block" type="button" onClick={onContinue}>Продолжить попытку</button>
      <button className="s-btn s-btn--outline s-btn--block" type="button" onClick={onRestart}>Начать заново</button>
      <p className="pf-note" style={{ textAlign: 'center' }}>
        «Начать заново» сбросит прогресс попытки. Заработанные монеты останутся при вас.
      </p>
    </div>
  );
}
