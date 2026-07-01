'use client';

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import type { QuestSnapshot } from '../../lib/shared-model';
import { loadQuestSnapshot } from '../../lib/shared-model';
import { getActiveAttempt, getBundle, getLatestBundleForQuest } from '../../lib/queue';
import { storeBundle, precacheBundleMedia } from '../../lib/download';
import { api } from '../../lib/api';
import { currentPlayerId } from '../../lib/identity';
import { PlayerFrame, Flourish } from '../player/PlayerComponents';
import QuestPlayerClient from './QuestPlayerClient';

type GateState =
  | { kind: 'loading' }
  | { kind: 'ready'; snapshot: QuestSnapshot; snapshotId: string }
  | { kind: 'denied' }
  | { kind: 'login-required' }
  | { kind: 'unavailable'; offline: boolean };

function httpStatus(err: unknown): number | null {
  const m = err instanceof Error ? /^API (\d{3}) /.exec(err.message) : null;
  return m ? Number(m[1]) : null;
}

/**
 * Snapshot resolution gate — resolves BEFORE first paint of the player so the
 * snapshot never swaps mid-attempt (version freeze):
 *   1. the attempt-bound downloaded bundle,
 *   2. the latest downloaded bundle for the quest,
 *   3. the server bundle (grant-gated 403; stored locally so the next open is
 *      offline-capable).
 * There is no fixture fallback and no client-side grant synthesis: access is
 * enforced by the server, full stop. IndexedDB is client-only, hence this thin
 * gate under the RSC shell.
 */
export default function BundleGate({ questId }: { questId: string }) {
  const [state, setState] = useState<GateState>({ kind: 'loading' });

  useEffect(() => {
    let cancelled = false;
    const apply = (next: GateState) => {
      if (!cancelled) setState(next);
    };
    void (async () => {
      try {
        const attempt = await getActiveAttempt(questId);
        const bundle =
          (attempt && (await getBundle(attempt.snapshot_id))) || (await getLatestBundleForQuest(questId));
        if (bundle) {
          apply({ kind: 'ready', snapshot: bundle.snapshot, snapshotId: bundle.snapshot_id });
          return;
        }
      } catch {
        // IndexedDB unavailable — fall through to the network path.
      }
      try {
        const wire = await api.getBundle(questId, currentPlayerId());
        const snapshot = loadQuestSnapshot(wire.snapshot);
        apply({ kind: 'ready', snapshot, snapshotId: wire.snapshot_id });
        // Persist + warm media (snapshot refs + the envelope's cover) in the background
        // so a quest merely OPENED online — not just explicitly «Скачать»-ed — is fully
        // playable offline next time. Off the first-paint path; best-effort, so a failure
        // never breaks play.
        void storeBundle(wire)
          .then((row) => precacheBundleMedia(row.snapshot_id, row.snapshot, wire.primary_comic))
          .catch(() => {});
      } catch (err) {
        const status = httpStatus(err);
        if (status === 403) apply({ kind: 'denied' });
        else if (status === 401) apply({ kind: 'login-required' });
        else apply({ kind: 'unavailable', offline: typeof navigator !== 'undefined' && !navigator.onLine });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [questId]);

  if (state.kind === 'loading') {
    return <GateScreen title="Загружаем квест…" text="Секунду — открываем вашу попытку." />;
  }
  if (state.kind === 'denied') {
    return (
      <GateScreen
        title="Нужен доступ"
        text="Этот квест появится в вашей коллекции после покупки — навсегда, со всеми обновлениями."
        cta={{ href: '/#shop', label: 'Выбрать в магазине' }}
      />
    );
  }
  if (state.kind === 'login-required') {
    return (
      <GateScreen
        title="Нужен вход"
        text="Этот квест привязан к аккаунту, в который вы сейчас не вошли. Войдите, чтобы открыть свою коллекцию."
        cta={{ href: '/auth', label: 'Войти в аккаунт' }}
      />
    );
  }
  if (state.kind === 'unavailable') {
    return (
      <GateScreen
        title="Квест недоступен"
        text={
          state.offline
            ? 'Вы офлайн, а этот квест ещё не скачан на устройство. Подключитесь к сети или скачайте его заранее в «Моих квестах».'
            : 'Не удалось открыть квест. Возможно, он не опубликован или адрес неверен.'
        }
        cta={{ href: '/my-quests', label: 'К моим квестам' }}
      />
    );
  }
  return <QuestPlayerClient snapshot={state.snapshot} questId={questId} snapshotId={state.snapshotId} />;
}

/** Terminal gate states in the player's paper language (frame, flourish, outline button). */
function GateScreen({ title, text, cta }: { title: string; text: string; cta?: { href: string; label: string } }) {
  return (
    <PlayerFrame tw={{ art: 'paper', layout: 'image', anims: false }} screenLabel="player-gate">
      <div className="p-stepbody" style={{ justifyContent: 'center', textAlign: 'center' }}>
        <h1 className="p-title">{title}</h1>
        <Flourish />
        <p className="p-text" style={{ textAlign: 'center' }}>{text}</p>
        {cta && (
          <div className="p-actions" style={{ justifyContent: 'center' }}>
            <Link className="p-btn" href={cta.href}>{cta.label}</Link>
          </div>
        )}
      </div>
    </PlayerFrame>
  );
}
