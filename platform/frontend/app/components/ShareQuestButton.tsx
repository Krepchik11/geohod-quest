'use client';

import React from 'react';
import { shareQuest, type ShareQuestInput } from '../../lib/share';
import { toast } from './Toaster';

/**
 * «Поделиться» — the one share affordance, worn two ways.
 *
 * Unlike the install button it is never hidden by platform: where there is no
 * OS share sheet the link goes to the clipboard instead, so every browser has
 * a working path. Flag gating lives with the CALLER — the quest finale renders
 * this button unconditionally, because `/api/features` is unreachable offline
 * and the finale is exactly where the player usually is.
 *
 * `variant="icon"` is for dense rows (My Quests, shop cards), where the design
 * allows only ONE full-width CTA.
 */
export default function ShareQuestButton({
  quest,
  variant = 'button',
  className,
}: {
  quest: ShareQuestInput;
  variant?: 'button' | 'icon';
  className?: string;
}) {
  // Called straight from onClick — `navigator.share` needs the transient user
  // activation that an await before it would spend.
  const onShare = (e: React.MouseEvent) => {
    // The shop card wraps its whole body in a stretched link; without this the
    // click would navigate to the product page instead of sharing.
    e.preventDefault();
    e.stopPropagation();
    void shareQuest(quest).then((outcome) => {
      if (outcome === 'copied') toast('Ссылка на квест скопирована');
      if (outcome === 'failed') toast('Не удалось поделиться — скопируйте адрес из строки браузера');
    });
  };

  if (variant === 'icon') {
    return (
      <button
        className={`share-ico${className ? ` ${className}` : ''}`}
        type="button"
        aria-label="Поделиться квестом"
        title="Поделиться квестом"
        onClick={onShare}
      >
        <span className="ic share-ico__gl" aria-hidden />
      </button>
    );
  }

  return (
    <button
      className={`btn btn--secondary btn--md${className ? ` ${className}` : ''}`}
      type="button"
      onClick={onShare}
    >
      Поделиться
    </button>
  );
}
