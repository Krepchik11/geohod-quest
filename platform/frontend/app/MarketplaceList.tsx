'use client';

import React from 'react';
import type { PublishedQuest } from './page'; // co-located, narrow import (no barrel)

interface Props {
  quests: PublishedQuest[];
  owned: Record<string, boolean>;
  onBuy: (questId: string, coupon?: number) => void;
}

/**
 * Small focused MarketplaceList (per react.md + design: narrow, derived render, explicit conds, props only, no god, no inside comps, no waterfalls).
 * Renders comic stub + template summary (100% from caller snapshot/goldens reuse) + Buy/Get free buttons.
 * No local state/dupe logic; parent (page island) owns owned/buy.
 */
export function MarketplaceList({ quests, owned, onBuy }: Props) {
  return (
    <div className="space-y-4">
      {quests.map((q) => {
        const isOwned = owned[q.quest_id];
        return (
          <div key={q.quest_id} className="rounded border p-4 dark:border-zinc-700">
            <div className="font-medium">
              {q.name} {isOwned ? '(Owned)' : ''}
            </div>
            <div className="text-xs text-zinc-500">comic: {q.primary_comic || '—'} • {q.template_summary}</div>
            {!isOwned ? (
              <div className="mt-2 flex gap-2">
                <button
                  onClick={() => onBuy(q.quest_id)}
                  className="rounded bg-black px-3 py-1 text-xs text-white"
                >
                  Buy once
                </button>
                <button
                  onClick={() => onBuy(q.quest_id, 100)}
                  className="rounded border px-3 py-1 text-xs"
                >
                  Get free (100%)
                </button>
              </div>
            ) : (
              <a href={`/quest?golden=${q.quest_id}`} className="text-xs underline">
                Owned — Play
              </a>
            )}
          </div>
        );
      })}
    </div>
  );
}