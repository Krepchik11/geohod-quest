'use client';

import React, { useEffect, useState, useCallback } from 'react';
import Link from 'next/link';
import SiteShell from '../components/SiteShell';
import { toast } from '../components/Toaster';
import { api, type PublishedQuestWire } from '../../lib/api';
import { fetchOwned } from '../../lib/collection';
import { projectState, latestRating } from '../../lib/shared-model';
import { getActiveAttempt, getFacts, getLatestBundleForQuest, type BundleRow } from '../../lib/queue';
import { downloadBundle, type DownloadStage } from '../../lib/download';
import { coverSrc } from '../../lib/cover';
import { currentUserId } from '../../lib/identity';
import { useClientFeature } from '../../lib/client-features';
import ShareQuestButton from '../components/ShareQuestButton';

/**
 * «Мои квесты» v2 (SPEC §4 / My Quests v2.dc.html) — live collection:
 * published quests × grants × local queue (attempt state) × bundles store
 * (download state). 100% live data.
 *
 * §4.1: ONE honest CTA per row — «Продолжить» / «Начать» / «Пройти заново».
 * Restart lives only in the player's start gate (context + «монеты останутся»).
 * §4.2: offline is a visible quiet-pill button → progress in the same slot →
 * «⭳ офлайн» cover badge; failures toast with «Повторить» (alert() is banned).
 * §4.4: no install affordance here at all — the global install lives in
 * Profile; each quest installs from its own product page, whose quest-scoped
 * manifest makes the browser prompt for THAT quest's app. A list-side link
 * can't do better: prompt() needs transient user activation, which navigation
 * destroys, and installed-state is undetectable across manifest scopes.
 */

interface MqRow {
  quest_id: string;
  title: string;
  city: string | null;
  duration: string | null;
  photo: string | null;
  state: 'new' | 'progress' | 'done';
  pos?: number;
  total?: number;
  attemptDate?: string;
  /** The player's own finale rating (1–5), 0 = none. */
  myRating: number;
  version: number;
  publishedSnapshotId: string;
  bundle: BundleRow | null;
  /** A newer version is published than the downloaded bundle. */
  updateAvailable: boolean;
}

type Collection =
  | { source: 'loading' }
  | { source: 'live'; rows: MqRow[] }
  | { source: 'error' };

/** §4.1 (2.3): dates carry the year — «28.06.2026». */
export function formatDate(iso: string | undefined): string {
  if (!iso) return '';
  return new Date(iso).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

/** §4.1: the one honest CTA per state. */
export function ctaFor(state: MqRow['state']): { label: string; variant: 'primary' | 'secondary'; restart: boolean } {
  if (state === 'progress') return { label: 'Продолжить', variant: 'primary', restart: false };
  if (state === 'done') return { label: 'Пройти заново', variant: 'secondary', restart: true };
  return { label: 'Начать', variant: 'primary', restart: false };
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
    city: meta.city,
    duration: meta.duration,
    photo: coverSrc(meta.primary_comic),
    state,
    pos: attempt ? Math.min(attempt.last_step_idx + 1, total ?? attempt.last_step_idx + 1) : undefined,
    total,
    attemptDate: attempt?.created_at,
    myRating: latestRating(facts),
    version: meta.snapshot_version,
    publishedSnapshotId: meta.snapshot_id,
    bundle,
    updateAvailable: !!bundle && bundle.snapshot_id !== meta.snapshot_id,
    ...(proj.completedSteps.length > 0 && state === 'progress' && total
      ? { pos: Math.min(Math.max(...proj.completedSteps) + 2, total) }
      : {}),
  };
}

const STAGE_WIDTH: Record<DownloadStage, number> = { fetching: 33, storing: 66, caching: 90, done: 100 };

/**
 * §4.2 offline slot: quiet-pill button → same-slot progress → (cover badge
 * takes over once the bundle exists). Sizes are honest: bundle byte size is
 * unknown before the fetch, so the button and the progress line name the
 * action, not a fabricated number.
 */
function MqDl({ q, stage, onDownload }: { q: MqRow; stage: DownloadStage | null; onDownload: () => void }) {
  if (stage && stage !== 'done') {
    return (
      <span className="mq-dl mq-dl--busy">
        <span className="psheet__spinner mq-dl__spin" aria-hidden />
        <span className="mq-dl__col">
          <span>Скачиваем для офлайна…</span>
          <span className="dl-bar"><i style={{ width: `${STAGE_WIDTH[stage]}%` }} /></span>
        </span>
      </span>
    );
  }
  if (q.bundle) return null; // the «⭳ офлайн» cover badge says it all
  return (
    <button className="btn btn--quiet mq-dl__btn" type="button" onClick={onDownload}>
      ⭳ Скачать для офлайна
    </button>
  );
}

function Stars({ n }: { n: number }) {
  return (
    <span className="mq-stars" aria-label={`Оценка ${n} из 5`}>
      {[1, 2, 3, 4, 5].map((i) => (
        <span key={i} className={i <= n ? '' : 'is-off'}>★</span>
      ))}
    </span>
  );
}

/** Meta line: place · duration · attempt/completion date (with year). */
function metaLine(q: MqRow): string[] {
  const parts = [q.city, q.duration].filter((p): p is string => !!p);
  if (q.state === 'done' && q.attemptDate) parts.push(`пройден ${formatDate(q.attemptDate)}`);
  else if (q.state === 'progress' && q.attemptDate) parts.push(`попытка от ${formatDate(q.attemptDate)}`);
  else if (q.state === 'new') parts.push('не начат');
  return parts;
}

async function loadCollection(): Promise<Collection> {
  let quests: PublishedQuestWire[];
  try {
    quests = await api.listQuests();
  } catch {
    return { source: 'error' };
  }
  const ownedIds = await fetchOwned();
  const owned = quests.filter((q) => ownedIds.has(q.quest_id));
  const rows = await Promise.all(owned.map(composeRow));
  return { source: 'live', rows };
}

export default function MyQuestsPage() {
  const [collection, setCollection] = useState<Collection>({ source: 'loading' });
  const shareOn = useClientFeature('quest_share');
  const [downloads, setDownloads] = useState<Record<string, DownloadStage | null>>({});

  const reload = useCallback(() => {
    setCollection({ source: 'loading' });
    void loadCollection().then(setCollection);
  }, []);

  useEffect(() => {
    let cancelled = false;
    loadCollection().then((c) => {
      if (!cancelled) setCollection(c);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Function declaration (hoisted) so the toast's «Повторить» can re-invoke it.
  async function handleDownload(questId: string) {
    setDownloads((d) => ({ ...d, [questId]: 'fetching' }));
    try {
      await downloadBundle(questId, currentUserId(), api, (stage) =>
        setDownloads((d) => ({ ...d, [questId]: stage })),
      );
      setCollection(await loadCollection()); // re-compose (badge + step totals from the bundle)
    } catch {
      setDownloads((d) => ({ ...d, [questId]: null }));
      // §4.2: toast with a retry action, never alert().
      toast('Не удалось скачать квест — проверьте связь', {
        label: 'Повторить',
        onClick: () => void handleDownload(questId),
      });
    }
  }

  const rows = collection.source === 'live' ? collection.rows : [];

  return (
    <SiteShell>
      <main className="co-wrap">
        <h2 className="co-title">Мои квесты</h2>
        <p className="co-sub">Все купленные и полученные квесты. Доступ бессрочный — проходите когда удобно.</p>

        {collection.source === 'loading' ? (
          <p className="mq-sub" style={{ marginTop: 24 }}>Загружаем коллекцию…</p>
        ) : collection.source === 'error' ? (
          <div className="card mq-empty" style={{ marginTop: 24 }}>
            <p className="mq-empty__text">Не удалось загрузить коллекцию.<br />Проверьте подключение — и попробуем снова.</p>
            <button className="btn btn--sm" type="button" onClick={reload}>Повторить</button>
          </div>
        ) : rows.length === 0 ? (
          <div className="card mq-empty" style={{ marginTop: 24 }}>
            <p className="mq-empty__text">Пока пусто. Выберите первый квест —<br />и город станет игрой.</p>
            <Link className="btn btn--sm" href="/#shop">В магазин квестов</Link>
          </div>
        ) : (
          <div className="mq-list">
            {rows.map((q) => {
              const open = `/quest/${encodeURIComponent(q.quest_id)}`;
              const cta = ctaFor(q.state);
              const stage = downloads[q.quest_id] ?? null;
              return (
                <div className="card mq-row" key={q.quest_id} data-state={q.state}>
                  <div
                    className="mq-row__photo"
                    style={{ backgroundImage: q.photo ? `url(${q.photo})` : undefined, backgroundColor: q.photo ? undefined : 'var(--navy)' }}
                  >
                    {!q.photo && <span className="qmark">?</span>}
                    {q.state === 'done' && <span className="mq-cover-badge mq-cover-badge--done">Пройден</span>}
                    {q.state === 'progress' && <span className="mq-cover-badge mq-cover-badge--progress mq-cover-badge--mobile">В процессе</span>}
                    {q.state === 'new' && <span className="mq-cover-badge mq-cover-badge--new mq-cover-badge--mobile">Не начат</span>}
                    {q.bundle && <span className="mq-cover-badge mq-cover-badge--offline">⭳ офлайн</span>}
                    {q.state === 'progress' && q.pos && q.total && (
                      <span className="mq-cover-progress" aria-hidden><span style={{ width: `${(q.pos / q.total) * 100}%` }} /></span>
                    )}
                  </div>

                  <div className="mq-row__body">
                    <div className="mq-row__titleline">
                      <h3>{q.title}</h3>
                      {q.updateAvailable && (
                        <button className="mq-update-chip" type="button" onClick={() => void handleDownload(q.quest_id)}>
                          Доступно обновление · обновить
                        </button>
                      )}
                    </div>
                    <p className="mq-row__meta">
                      {metaLine(q).map((part, i) => (
                        <React.Fragment key={i}>{i > 0 && <span className="mq-dot">·</span>}<span>{part}</span></React.Fragment>
                      ))}
                    </p>
                    {q.state === 'progress' && q.pos && q.total && (
                      <div className="mq-progress">
                        <div className="mq-progressline"><i style={{ width: `${(q.pos / q.total) * 100}%` }} /></div>
                        <span className="mq-progress__label">шаг {q.pos} из {q.total}</span>
                      </div>
                    )}
                    {q.state === 'done' && q.myRating > 0 && (
                      <p className="mq-rating"><span>Ваша оценка</span><Stars n={q.myRating} /></p>
                    )}
                    {q.state === 'done' && q.myRating === 0 && (
                      <p className="mq-rating"><span>без оценки</span></p>
                    )}
                    <MqDl q={q} stage={stage} onDownload={() => void handleDownload(q.quest_id)} />
                  </div>

                  <div className="mq-actions">
                    <Link className={`btn ${cta.variant === 'secondary' ? 'btn--secondary' : ''}`} href={cta.restart ? `${open}?restart=1` : open}>
                      {cta.label}
                    </Link>
                    {/* §4.1 keeps ONE honest CTA per row, so sharing is an icon, not a
                        second button. */}
                    {shareOn && (
                      <ShareQuestButton
                        variant="icon"
                        quest={{ questId: q.quest_id, name: q.title, city: q.city }}
                      />
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </main>
    </SiteShell>
  );
}
