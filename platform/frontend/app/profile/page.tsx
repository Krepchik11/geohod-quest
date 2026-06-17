'use client';

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import SiteHeader from '../SiteHeader';
import { api, ApiError } from '../../lib/api';

/**
 * «Мой профиль» — structure and RU copy ported from design/myquests/screens.jsx
 * (ProfilePage). Tiles are LIVE from /api/players/me/stats (cross-attempt server
 * fold: signed balance, rating display-floored at 0 per SPEC, quests completed);
 * user data from /api/players/me (email when registered, anonymous label
 * otherwise). Completed-quest ids are mapped to display titles via the published
 * catalog. On failure the page shows an explicit degraded state — distinguishing
 * an expired session (auth) from a genuine outage (network) — instead of the old
 * misleading "офлайн-данные" fallback that read a hardcoded single-quest key.
 */

interface LiveStats {
  balance: number;
  quests_completed: number;
  completed_quest_ids: string[];
  attempts_count: number;
  grants_count: number;
}

interface Me {
  player_id: string;
  registered: boolean;
  email: string | null;
  display_name: string | null;
}

type ProfileData =
  | { source: 'loading' }
  | { source: 'live'; me: Me; stats: LiveStats; titles: Record<string, string> }
  | { source: 'error'; kind: 'auth' | 'network' };

export default function ProfilePage() {
  const [data, setData] = useState<ProfileData>({ source: 'loading' });

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [me, stats] = await Promise.all([api.me(), api.myStats()]);
        // Best-effort id → title map so completed quests render their names, not
        // raw ids. A catalog failure just falls back to showing the id.
        let titles: Record<string, string> = {};
        try {
          const quests = await api.listQuests();
          titles = Object.fromEntries(quests.map((q) => [q.quest_id, q.name]));
        } catch {
          /* keep raw ids */
        }
        if (!cancelled) setData({ source: 'live', me, stats, titles });
      } catch (err) {
        if (cancelled) return;
        const status = err instanceof ApiError ? err.status : null;
        setData({ source: 'error', kind: status === 401 || status === 403 ? 'auth' : 'network' });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const live = data.source === 'live' ? data : null;
  const authError = data.source === 'error' && data.kind === 'auth';
  const balance = live ? live.stats.balance : 0;
  const rating = Math.max(balance, 0);
  const completed = live ? live.stats.quests_completed : 0;
  const completedIds = live ? live.stats.completed_quest_ids : [];

  const identityLabel = live?.me.registered
    ? (live.me.display_name ?? live.me.email ?? '')
    : 'Анонимный игрок';
  const emailLabel = live?.me.registered ? (live.me.email ?? '—') : '—';

  return (
    <div className="site min-h-screen" style={{ background: '#fff', display: 'flex', flexDirection: 'column' }}>
      <SiteHeader />
      <main className="co-wrap">
        <h2 className="co-title">Мой профиль</h2>
        {data.source === 'error' && (
          <p className="pf-note" style={{ color: '#B45309' }}>
            {data.kind === 'auth'
              ? 'Сессия устарела — войдите снова, чтобы увидеть свой профиль.'
              : 'Не удалось связаться с сервером — попробуйте позже.'}
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
                {live?.me.registered
                  ? 'зарегистрирован'
                  : authError
                    ? <Link className="s-link" href="/auth">войти</Link>
                    : <>анонимный · <Link className="s-link" href="/auth">зарегистрироваться</Link></>}
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
                  <span>{live?.titles[id] ?? id}</span>
                  <span className="mq-stars">{Array.from({ length: 5 }, (_, i) => <span className="st" key={i} />)}</span>
                </div>
              ))
            ) : (
              <p className="pf-note">Пока нет пройденных квестов.</p>
            )}
            <Link className="s-btn s-btn--outline" href="/my-quests">Все мои квесты</Link>
          </div>
        </div>
      </main>
    </div>
  );
}
