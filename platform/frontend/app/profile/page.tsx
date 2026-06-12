'use client';

import React, { useEffect, useState, useSyncExternalStore } from 'react';
import Link from 'next/link';
import SiteHeader from '../SiteHeader';
import { api } from '../../lib/api';
import { projectBalance, type Fact } from '../../lib/shared-model';

/**
 * «Мой профиль» — structure and RU copy ported from design/myquests/screens.jsx
 * (ProfilePage). Game tiles are LIVE from /api/players/me/stats (cross-attempt
 * server fold: signed balance, rating display-floored at 0 per SPEC, quests
 * completed); user data from /api/players/me (email when registered, anonymous
 * label otherwise). When the backend is unreachable the tiles fall back to the
 * local fact-log fold, clearly labeled (player-stats spec).
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
  | { source: 'live'; me: Me; stats: LiveStats }
  | { source: 'local-fallback' };

const EMPTY_FACTS: Fact[] = [];
let cachedRaw: string | null = null;
let cachedFacts: Fact[] = EMPTY_FACTS;

function readLocalFacts(): Fact[] {
  try {
    const raw = localStorage.getItem('quest-player-mystery-fortress-v1');
    if (raw === cachedRaw) return cachedFacts;
    cachedRaw = raw;
    cachedFacts = raw ? ((JSON.parse(raw).facts as Fact[]) ?? EMPTY_FACTS) : EMPTY_FACTS;
    return cachedFacts;
  } catch {
    return EMPTY_FACTS;
  }
}

function subscribeStorage(cb: () => void) {
  window.addEventListener('storage', cb);
  return () => window.removeEventListener('storage', cb);
}

export default function ProfilePage() {
  const [data, setData] = useState<ProfileData>({ source: 'loading' });
  const localFacts = useSyncExternalStore(subscribeStorage, readLocalFacts, () => EMPTY_FACTS);

  useEffect(() => {
    let cancelled = false;
    Promise.all([api.me(), api.myStats()])
      .then(([me, stats]) => {
        if (!cancelled) setData({ source: 'live', me, stats });
      })
      .catch(() => {
        if (!cancelled) setData({ source: 'local-fallback' });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const live = data.source === 'live' ? data : null;
  const balance = live ? live.stats.balance : projectBalance(localFacts);
  const rating = Math.max(balance, 0);
  const completed = live
    ? live.stats.quests_completed
    : localFacts.some((f) => f.type === 'attempt_completed')
      ? 1
      : 0;
  const completedIds = live ? live.stats.completed_quest_ids : completed > 0 ? ['Тайна крепости'] : [];

  const identityLabel = live?.me.registered
    ? (live.me.display_name ?? live.me.email ?? '')
    : 'Анонимный игрок';
  const emailLabel = live?.me.registered ? (live.me.email ?? '—') : '—';

  return (
    <div className="site min-h-screen" style={{ background: '#fff', display: 'flex', flexDirection: 'column' }}>
      <SiteHeader />
      <main className="co-wrap">
        <h2 className="co-title">Мой профиль</h2>
        {data.source === 'local-fallback' && (
          <p className="pf-note" style={{ color: '#B45309' }}>
            офлайн-данные с этого устройства — сервер недоступен
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
                  <span>{id}</span>
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
