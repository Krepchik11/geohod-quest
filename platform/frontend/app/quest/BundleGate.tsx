'use client';

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { storeBundle, precacheBundleMedia } from '../../lib/download';
import { api } from '../../lib/api';
import { currentUserId } from '../../lib/identity';
import { resolveGate, type GateResolution } from '../../lib/bundle-resolver';
import { PlayerFrame, Flourish } from '../player/PlayerComponents';
import QuestPlayerClient from './QuestPlayerClient';

type GateState = { kind: 'loading' } | GateResolution;

/**
 * Snapshot resolution gate — resolves BEFORE first paint of the player. The
 * decision itself lives in `lib/bundle-resolver` (unit-tested); this component
 * only feeds it the runtime (network, player id, restart intent) and renders the
 * outcome. Version freeze (an in-progress attempt keeps its snapshot) and the
 * restart-adopts-latest rule both live in the resolver. Access is enforced by
 * the server — no fixture fallback, no client-side grant synthesis.
 */
export default function BundleGate({ questId }: { questId: string }) {
  const [state, setState] = useState<GateState>({ kind: 'loading' });

  useEffect(() => {
    let cancelled = false;
    const apply = (next: GateState) => {
      if (!cancelled) setState(next);
    };
    void (async () => {
      // «Пройти заново» (My Quests) and the finale «Начать заново» both arrive as
      // ?restart=1. Consume it HERE — the single place resolution happens — so a
      // restart re-resolves the latest published version; strip it once consumed
      // so a refresh resumes the fresh attempt instead of restarting again.
      const restart =
        typeof window !== 'undefined' &&
        new URLSearchParams(window.location.search).get('restart') === '1';
      const resolution = await resolveGate(questId, restart, {
        userId: currentUserId(),
        online: typeof navigator === 'undefined' || navigator.onLine,
        getBundle: (id, userId) => api.getBundle(id, userId),
        persist: async (wire) => {
          const row = await storeBundle(wire);
          void precacheBundleMedia(row.snapshot_id, row.snapshot, wire.primary_comic).catch(() => {});
        },
      });
      if (restart && !cancelled && typeof window !== 'undefined') {
        window.history.replaceState(null, '', `/quest/${encodeURIComponent(questId)}`);
      }
      apply(resolution);
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
