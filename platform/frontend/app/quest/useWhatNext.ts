'use client';

import { useEffect, useState } from 'react';
import { api, type PublishedQuestWire } from '../../lib/api';
import { fetchOwned } from '../../lib/collection';
import { CLUB_CHANNEL, CLUB_CHANNEL_URL } from '../../lib/contacts';
import { coverSrc } from '../../lib/cover';
import { pickNextQuest, priceLabel, questFacts } from '../../lib/storefront';
import type { WhatNext } from '../player/PlayerComponents';

const NOTHING_OWNED: ReadonlySet<string> = new Set();

/**
 * The finale's «Что дальше» (ТЗ, задача 32) for the real player: the club's
 * channel at once, and another quest of the same city once the catalog answers.
 * The catalog and the owned set are asked only when the finale is reached;
 * offline they never answer and the block simply goes without a quest.
 */
export function useWhatNext(
  questId: string,
  city: string | null | undefined,
  active: boolean,
  factsOn: boolean,
): WhatNext | undefined {
  const [found, setFound] = useState<PublishedQuestWire | null>(null);

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    // Inside a promise chain so a missing or throwing client never escapes as a
    // render error — the finale must stand whatever the network does.
    void Promise.resolve()
      .then(() => Promise.all([api.listQuests(), fetchOwned().catch(() => NOTHING_OWNED)]))
      .then(
        ([catalog, owned]) => {
          if (!cancelled) setFound(pickNextQuest(catalog, questId, city ?? null, owned));
        },
        () => { /* offline: no next quest to offer */ },
      );
    return () => { cancelled = true; };
  }, [active, questId, city]);

  if (!active) return undefined;
  return {
    quest: found && {
      href: `/quest/${encodeURIComponent(found.quest_id)}/about`,
      name: found.name,
      meta: [found.city, questFacts(found, factsOn).time, priceLabel(found.price)].filter(Boolean).join(' · '),
      cover: coverSrc(found.primary_comic),
    },
    channel: { href: CLUB_CHANNEL_URL, name: CLUB_CHANNEL },
  };
}
