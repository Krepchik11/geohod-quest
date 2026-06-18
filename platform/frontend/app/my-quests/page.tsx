'use client';

import React, { useEffect, useState, useCallback } from 'react';
import Link from 'next/link';
import SiteHeader from '../SiteHeader';
import { api, type PublishedQuestWire } from '../../lib/api';
import { projectState } from '../../lib/shared-model';
import { getActiveAttempt, getFacts, getLatestBundleForQuest, type BundleRow } from '../../lib/queue';
import { downloadBundle, type DownloadStage } from '../../lib/download';
import { currentPlayerId } from '../../lib/identity';

/**
 * «Мои квесты» — live collection (P4): published quests × grants × local
 * queue (attempt state) × bundles store (download state). Structure, classes
 * and RU copy per design/myquests/screens.jsx; design demo rows remain only
 * as a clearly-labeled fallback when the backend is unreachable.
 *
 * Player-facing copy (UX): the player only cares "can I play this offline?".
 * Bundle size, "скачан/работает офлайн" wording, and quest version numbers are
 * implementation details — they are NOT shown. Offline-ready collapses to a
 * single "Доступно офлайн" marker; the update prompt is version-number-free.
 */

interface MqRow {
  quest_id: string;
  title: string;
  city: string;
  duration: string;
  photo: string | null;
  state: 'new' | 'progress' | 'done';
  pos?: number;
  total?: number;
  attemptDate?: string;
  version: number;
  publishedSnapshotId: string;
  bundle: BundleRow | null;
  /** A newer version is published than the downloaded bundle. */
  updateAvailable: boolean;
}

type Collection =
  | { source: 'loading' }
  | { source: 'live'; rows: MqRow[] }
  | { source: 'demo-fallback'; rows: MqRow[] };

/** Design fixture rows — shown ONLY when the backend is unreachable, labeled. */
const DEMO_FALLBACK_ROWS: MqRow[] = [
  {
    quest_id: 'mystery-fortress-v1',
    title: 'Тайна крепости (демо)',
    city: 'Нови Сад', duration: '2 часа',
    photo: null,
    state: 'new', version: 1, publishedSnapshotId: '',
    bundle: null, updateAvailable: false,
  },
];

function formatDate(iso: string | undefined): string {
  if (!iso) return '';
  return new Date(iso).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' });
}

/** Compose one live row from server meta + local queue/bundles state. */
async function composeRow(meta: PublishedQuestWire): Promise<MqRow> {
  const [attempt, bundle] = await Promise.all([
    getActiveAttempt(meta.quest_id),
    getLatestBundleForQuest(meta.quest_id),
  ]);
  const facts = attempt ? (await getFacts(attempt.attempt_key)).map((r) => r.fact) : [];
  const proj = projectState(facts);
  const total = bundle?.snapshot.steps.length;

  let state: MqRow['state'] = 'new';
  if (facts.some((f) => f.type === 'attempt_completed')) state = 'done';
  else if (facts.length > 0 || (attempt && attempt.last_step_idx > 0)) state = 'progress';

  return {
    quest_id: meta.quest_id,
    title: meta.name,
    city: 'Нови Сад',
    duration: '2 часа',
    // primary_comic is a media token today (e.g. "comic-fortress"), a path only later
    photo: meta.primary_comic?.startsWith('/') ? meta.primary_comic : null,
    state,
    pos: attempt ? Math.min(attempt.last_step_idx + 1, total ?? attempt.last_step_idx + 1) : undefined,
    total,
    attemptDate: attempt?.created_at,
    version: meta.snapshot_version,
    publishedSnapshotId: meta.snapshot_id,
    bundle,
    updateAvailable: !!bundle && bundle.snapshot_id !== meta.snapshot_id,
    ...(proj.completedSteps.length > 0 && state === 'progress' && total
      ? { pos: Math.min(Math.max(...proj.completedSteps) + 2, total) }
      : {}),
  };
}

function MqMeta({ city, duration }: { city: string; duration: string }) {
  return (
    <p className="mq-row__meta">
      <span><span className="ic" style={{ backgroundImage: 'url(/assets/icons/ic-pin--navy.svg)' }} />{city}</span>
      <span><span className="ic" style={{ backgroundImage: 'url(/assets/icons/ic-clock-ring--navy.svg)' }} />{duration}</span>
    </p>
  );
}

const STAGE_WIDTH: Record<DownloadStage, number> = { fetching: 33, storing: 66, caching: 90, done: 100 };

/**
 * Offline-availability marker. Players only need to know whether the quest
 * works without a connection — not the bundle size or technical status text.
 */
function MqDl({ q, stage, onDownload }: { q: MqRow; stage: DownloadStage | null; onDownload: () => void }) {
  if (stage && stage !== 'done') {
    return (
      <span className="mq-dl">
        Скачиваем…
        <span className="dl-bar" style={{ display: 'block', marginTop: 4 }}><i style={{ width: `${STAGE_WIDTH[stage]}%` }} /></span>
      </span>
    );
  }
  if (q.bundle) {
    return <span className="mq-dl mq-dl--ready">✓ Доступно офлайн</span>;
  }
  return (
    <span className="mq-dl">
      <button className="link" type="button" onClick={onDownload}>Скачать для офлайна</button>
    </span>
  );
}

/**
 * Attempt status. Version numbers are intentionally omitted — players care
 * about progress and last-played date, not which snapshot they are on.
 */
function MqState({ q }: { q: MqRow }) {
  if (q.state === 'progress') {
    return (
      <div className="mq-state">
        <span className="mq-badge mq-badge--progress">
          В процессе{q.pos && q.total ? <> · шаг {q.pos} из {q.total}</> : null}
        </span>
        {q.pos && q.total ? (
          <div className="mq-progressline"><i style={{ width: `${(q.pos / q.total) * 100}%` }} /></div>
        ) : null}
        <span className="mq-sub">Попытка от {formatDate(q.attemptDate)}</span>
      </div>
    );
  }
  if (q.state === 'done') {
    return (
      <div className="mq-state">
        <span className="mq-badge mq-badge--done">Пройден</span>
        <span className="mq-sub">Попытка от {formatDate(q.attemptDate)}</span>
      </div>
    );
  }
  return (
    <div className="mq-state">
      <span className="mq-badge mq-badge--new">Не начат</span>
      <span className="mq-sub">Доступ навсегда</span>
    </div>
  );
}

function MqActions({ q }: { q: MqRow }) {
  // The player's start gate (SPEC) confirms continue/restart with «монеты останутся».
  const open = `/quest/${encodeURIComponent(q.quest_id)}`;
  if (q.state === 'progress') {
    return (
      <div className="mq-actions">
        <Link className="btn" href={open}>Продолжить</Link>
        <Link className="btn btn--outline" href={open}>Начать заново</Link>
      </div>
    );
  }
  if (q.state === 'done') {
    // A completed quest reopens on its finale; ?restart=1 tells the player to
    // supersede that attempt and start a fresh run from step 0 (coins are kept).
    return <div className="mq-actions"><Link className="btn" href={`${open}?restart=1`}>Пройти заново</Link></div>;
  }
  return <div className="mq-actions"><Link className="btn" href={open}>Начать</Link></div>;
}

/**
 * Pure data composition — server lists × local queue/bundles. The catalog and
 * grants load independently: only a CATALOG failure (GET /api/quests, public)
 * shows the labeled demo fallback. If grants alone fail, the collection is simply
 * empty (live, no owned quests) rather than masquerading as "сервер недоступен".
 */
async function loadCollection(): Promise<Collection> {
  let quests: PublishedQuestWire[];
  try {
    quests = await api.listQuests();
  } catch {
    return { source: 'demo-fallback', rows: DEMO_FALLBACK_ROWS };
  }
  let ownedIds = new Set<string>();
  try {
    const grants = await api.listGrants();
    const playerId = currentPlayerId();
    ownedIds = new Set(grants.filter((g) => g.player_id === playerId).map((g) => g.quest_id));
  } catch {
    // Grants unavailable (transient auth/network): show an empty owned collection,
    // not demo rows — the catalog itself loaded fine.
    ownedIds = new Set();
  }
  const owned = quests.filter((q) => ownedIds.has(q.quest_id));
  const rows = await Promise.all(owned.map(composeRow));
  return { source: 'live', rows };
}

export default function MyQuestsPage() {
  const [collection, setCollection] = useState<Collection>({ source: 'loading' });
  const [downloads, setDownloads] = useState<Record<string, DownloadStage | null>>({});

  useEffect(() => {
    let cancelled = false;
    loadCollection().then((c) => {
      if (!cancelled) setCollection(c);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const handleDownload = useCallback(async (questId: string) => {
    setDownloads((d) => ({ ...d, [questId]: 'fetching' }));
    try {
      await downloadBundle(questId, currentPlayerId(), api, (stage) =>
        setDownloads((d) => ({ ...d, [questId]: stage }))
      );
      setCollection(await loadCollection()); // re-compose (download state + step totals from the bundle)
    } catch (err) {
      console.warn('bundle download failed', err);
      setDownloads((d) => ({ ...d, [questId]: null }));
      alert('Не удалось скачать квест — проверьте подключение и доступ.');
    }
  }, []);

  const rows = collection.source === 'loading' ? [] : collection.rows;

  return (
    <div className="site min-h-screen" style={{ background: '#fff', display: 'flex', flexDirection: 'column' }}>
      <SiteHeader />
      <main className="co-wrap">
        <h2 className="co-title">Мои квесты</h2>
        <p className="co-sub">Все купленные и полученные квесты. Доступ бессрочный — проходите когда удобно.</p>

        {collection.source === 'demo-fallback' && (
          <p className="mq-sub" style={{ color: '#B45309' }}>
            демо-данные — сервер недоступен, реальная коллекция появится после подключения
          </p>
        )}

        {collection.source === 'loading' ? (
          <p className="mq-sub" style={{ marginTop: 24 }}>Загружаем коллекцию…</p>
        ) : rows.length === 0 ? (
          <div className="card mq-empty" style={{ marginTop: 24 }}>
            <div className="ic-ring">?</div>
            <h3>Пока ни одного квеста</h3>
            <p>Выберите квест в магазине — после покупки или получения он появится здесь и останется навсегда.</p>
            <Link className="btn" href="/">В магазин квестов</Link>
          </div>
        ) : (
          <div className="mq-list">
            {rows.map((q) => (
              <div className="card mq-row" key={q.quest_id}>
                <div
                  className="mq-row__photo"
                  style={{ backgroundImage: q.photo ? `url(${q.photo})` : undefined, backgroundColor: q.photo ? undefined : 'var(--navy)' }}
                >
                  {!q.photo && <span className="qmark">?</span>}
                </div>
                <div className="mq-row__body">
                  <MqMeta city={q.city} duration={q.duration} />
                  <h3>{q.title}</h3>
                  <MqDl q={q} stage={downloads[q.quest_id] ?? null} onDownload={() => void handleDownload(q.quest_id)} />
                  {q.updateAvailable && (
                    <div className="mq-version">
                      Доступно обновление.{' '}
                      <button className="link" type="button" onClick={() => void handleDownload(q.quest_id)}>Обновить</button>
                    </div>
                  )}
                </div>
                <MqState q={q} />
                <MqActions q={q} />
              </div>
            ))}
          </div>
        )}
      </main>
    </div>
  );
}
