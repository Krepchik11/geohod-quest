'use client';

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import SiteHeader from '../SiteHeader';
import { api, ApiError } from '../../lib/api';
import { flushAll } from '../../lib/sync';
import { currentPlayerId, getSession } from '../../lib/identity';
import {
  foldLocalPlayerStats,
  gatherLocalAttemptLogs,
  mergeProfileStats,
  type PlayerStatsFold,
} from '../../lib/player-stats';

/**
 * «Мой профиль» — structure and RU copy ported from design/myquests/screens.jsx
 * (ProfilePage). The tiles reflect the ACTUAL situation, not just whatever has
 * synced: the page folds the device's local fact log (the same source «Мои
 * квесты» trusts) for immediate truth, drains any never-synced facts to the
 * server (flushAll — recovers completions stranded by the old "no flush after
 * finish" gap), then merges the server's authoritative cross-device aggregate on
 * top. So a quest finished offline, or finished a second ago, shows its coins and
 * completion right away; a registered account on a second device still sees the
 * server total. Identity comes from /api/players/me, falling back to the stored
 * session when the server is unreachable. A degraded note distinguishes an expired
 * session from a real outage — but data still renders from the local fold.
 */

interface Me {
  player_id: string;
  registered: boolean;
  email: string | null;
  display_name: string | null;
}

type ProfileData =
  | { source: 'loading' }
  | {
      source: 'ready';
      me: Me | null;
      server: PlayerStatsFold | null;
      local: PlayerStatsFold;
      titles: Record<string, string>;
      /** Set only when the server could not be read; data falls back to `local`. */
      error: 'auth' | 'network' | null;
    };

const EMPTY_FOLD: PlayerStatsFold = { balance: 0, completed_quest_ids: [] };

export default function ProfilePage() {
  const [data, setData] = useState<ProfileData>({ source: 'loading' });

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      // 1) Local truth first — present even offline / before any sync.
      let local: PlayerStatsFold = EMPTY_FOLD;
      try {
        local = foldLocalPlayerStats(await gatherLocalAttemptLogs());
      } catch {
        /* IndexedDB unavailable — local stays empty */
      }

      // 2) Push anything that never synced (best-effort), so the server read below
      //    reflects this device's play under the current identity.
      try {
        await flushAll({ playerId: currentPlayerId(), api });
      } catch {
        /* offline / no grant recoverable — local fold still carries the truth */
      }

      // 3) Authoritative identity + cross-device aggregate.
      let me: Me | null = null;
      let server: PlayerStatsFold | null = null;
      let error: 'auth' | 'network' | null = null;
      try {
        const [meRes, statsRes] = await Promise.all([api.me(), api.myStats()]);
        me = meRes;
        server = {
          balance: statsRes.balance,
          completed_quest_ids: statsRes.completed_quest_ids,
        };
      } catch (err) {
        const status = err instanceof ApiError ? err.status : null;
        error = status === 401 || status === 403 ? 'auth' : 'network';
      }

      // 4) id → title map so completed quests render names, not raw ids.
      let titles: Record<string, string> = {};
      try {
        const quests = await api.listQuests();
        titles = Object.fromEntries(quests.map((q) => [q.quest_id, q.name]));
      } catch {
        /* keep raw ids */
      }

      if (!cancelled) setData({ source: 'ready', me, server, local, titles, error });
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const ready = data.source === 'ready' ? data : null;
  const merged = mergeProfileStats(ready?.server ?? null, ready?.local ?? EMPTY_FOLD);
  const balance = merged.balance;
  const rating = Math.max(balance, 0);
  const completedIds = merged.completedIds;
  const completed = completedIds.length;

  // Identity: server `me` wins; fall back to the stored session so a registered
  // user still sees their account when the server is briefly unreachable.
  const session = ready && !ready.me ? getSession() : null;
  const registered = ready ? (ready.me ? ready.me.registered : !!session) : false;
  const identityLabel = registered
    ? ready?.me?.display_name ?? ready?.me?.email ?? session?.display_name ?? session?.email ?? ''
    : 'Анонимный игрок';
  const emailLabel = registered ? ready?.me?.email ?? session?.email ?? '—' : '—';

  // Degraded note only when the server read failed; the tiles below still render
  // from the local fold, so this explains a possibly-incomplete cross-device total
  // rather than blanking the page.
  const errorNote =
    ready?.error === 'auth'
      ? 'Сессия устарела — войдите снова, чтобы свести данные со всех устройств. Показаны данные этого устройства.'
      : ready?.error === 'network'
        ? 'Не удалось связаться с сервером — показаны данные этого устройства.'
        : null;

  return (
    <div className="site min-h-screen" style={{ background: '#fff', display: 'flex', flexDirection: 'column' }}>
      <SiteHeader />
      <main className="co-wrap">
        <h2 className="co-title">Мой профиль</h2>
        {errorNote && (
          <p className="pf-note" style={{ color: '#B45309' }}>
            {errorNote}
          </p>
        )}
        <div className="pf-grid">
          <div className="s-card pf-card">
            <h4>Данные пользователя</h4>
            <div className="pf-row"><span className="lbl">Имя</span><span>{identityLabel}</span></div>
            <div className="pf-row"><span className="lbl">Email</span><span>{emailLabel}</span></div>
            <div className="pf-row">
              <span className="lbl">Аккаунт</span>
              <span>
                {ready?.error === 'auth' ? (
                  <Link className="s-link" href="/auth">войти снова</Link>
                ) : registered ? (
                  'зарегистрирован'
                ) : (
                  <>анонимный · <Link className="s-link" href="/auth">зарегистрироваться</Link></>
                )}
              </span>
            </div>
            <div className="co-divider" />
            <h4>Игровой счёт</h4>
            <div className="pf-tiles">
              <div className="pf-tile"><b><span className="pf-coin" />{balance}</b><span>монет на балансе</span></div>
              <div className="pf-tile"><b>{rating}</b><span>личный рейтинг</span></div>
              <div className="pf-tile"><b>{completed}</b><span>квестов пройдено</span></div>
            </div>
            <p className="pf-note">
              Монеты начисляются за задания и прохождение квестов, тратятся на подсказки.
              Рейтинг растёт вместе с монетами и не уходит ниже нуля.
            </p>
          </div>
          <div className="s-card pf-card">
            <h4>Пройденные квесты</h4>
            {completedIds.length > 0 ? (
              completedIds.map((id) => (
                <div className="pf-row" key={id}>
                  <span>{ready?.titles[id] ?? id}</span>
                  <span className="mq-stars">{Array.from({ length: 5 }, (_, i) => <span className="st" key={i} />)}</span>
                </div>
              ))
            ) : (
              <p className="pf-note">
                {data.source === 'loading' ? 'Загружаем профиль…' : 'Пока нет пройденных квестов.'}
              </p>
            )}
            <Link className="s-btn s-btn--outline" href="/my-quests">Все мои квесты</Link>
          </div>
        </div>
      </main>
    </div>
  );
}
