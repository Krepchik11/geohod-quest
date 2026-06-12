'use client';

import React, { useEffect, useState } from 'react';
import type { QuestSnapshot } from '../../lib/shared-model';
import { getActiveAttempt, getBundle, getLatestBundleForQuest } from '../../lib/queue';
import QuestPlayerClient from './QuestPlayerClient';

interface Resolved {
  snapshot: QuestSnapshot;
  snapshotId?: string;
}

/**
 * Snapshot resolution gate — resolves BEFORE first paint of the player so the
 * snapshot never swaps mid-attempt (version freeze): the attempt-bound bundle
 * wins, then the latest downloaded bundle for the quest, then the build-time
 * golden as the dev fallback. IndexedDB is client-only, hence this thin gate
 * under the RSC shell.
 */
export default function BundleGate({ questId, fallback }: { questId: string; fallback: QuestSnapshot }) {
  const [resolved, setResolved] = useState<Resolved | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      let next: Resolved = { snapshot: fallback };
      try {
        const attempt = await getActiveAttempt(questId);
        const bundle =
          (attempt && (await getBundle(attempt.snapshot_id))) || (await getLatestBundleForQuest(questId));
        if (bundle) next = { snapshot: bundle.snapshot, snapshotId: bundle.snapshot_id };
      } catch {
        // IndexedDB unavailable → golden fallback; play must never be blocked.
      }
      if (!cancelled) setResolved(next);
    })();
    return () => {
      cancelled = true;
    };
  }, [questId, fallback]);

  if (!resolved) {
    return <div className="p-6 text-center text-sm opacity-60">Загружаем квест…</div>;
  }
  return <QuestPlayerClient snapshot={resolved.snapshot} goldenId={questId} snapshotId={resolved.snapshotId} />;
}
