'use client';

import React, { useEffect, useState, useSyncExternalStore } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import SiteHeader from '../SiteHeader';
import SiteFooter from '../components/SiteFooter';
import InstallPrompt from '../components/InstallPrompt';
import { toast } from '../components/Toaster';
import { api, ApiError } from '../../lib/api';
import { flushAll } from '../../lib/sync';
import { currentPlayerId, getSession, subscribeSession } from '../../lib/identity';
import { logoutAndReset } from '../../lib/session-actions';
import {
  completedQuestDetails,
  foldLocalPlayerStats,
  gatherLocalAttemptLogs,
  mergeProfileStats,
  type AttemptLog,
  type PlayerStatsFold,
} from '../../lib/player-stats';
import { plural } from '../../lib/storefront';

/**
 * Профиль v2 (SPEC §7 / Profile v2.dc.html).
 *
 * §7.1 honest tiles: «монеты на балансе» + «квестов пройдено» — the fake
 * «личный рейтинг» (= max(balance,0)) is gone.
 * §7.2 completed quests show the date WITH the year and the player's own
 * latestRating as stars, or an honest «без оценки».
 * §7.3 account block: name, password, global app install, logout, delete.
 * §7.4 delete = consequences dialog + confirmation checkbox; authors with
 * published quests are blocked server-side and see the server's message.
 * §7.5 anonymous nudge appears only when there is something to lose.
 * Offline-first local data + the honest server-degradation note stay.
 */

interface Me {
  player_id: string;
  registered: boolean;
  email: string | null;
  display_name: string | null;
  email_confirmed_at?: number | null;
}

type ProfileData =
  | { source: 'loading' }
  | {
      source: 'ready';
      me: Me | null;
      server: PlayerStatsFold | null;
      local: PlayerStatsFold;
      logs: AttemptLog[];
      titles: Record<string, string>;
      purchases: number;
      error: 'auth' | 'network' | null;
    };

const EMPTY_FOLD: PlayerStatsFold = { balance: 0, completed_quest_ids: [] };

function fmtDate(iso: string | null): string {
  if (!iso) return '';
  return new Date(iso).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

function Stars({ n }: { n: number }) {
  if (n <= 0) return <span className="pf-norating">без оценки</span>;
  return (
    <span className="mq-stars" aria-label={`Оценка ${n} из 5`}>
      {[1, 2, 3, 4, 5].map((i) => <span key={i} className={i <= n ? '' : 'is-off'}>★</span>)}
    </span>
  );
}

export default function ProfilePage() {
  const [data, setData] = useState<ProfileData>({ source: 'loading' });
  const [banner, setBanner] = useState(true);
  const [sheet, setSheet] = useState<'name' | 'password' | 'delete' | null>(null);
  const session = useSyncExternalStore(subscribeSession, getSession, () => null);
  const router = useRouter();

  const reload = () => {
    setData({ source: 'loading' });
    void load();
  };

  const load = async () => {
    let local: PlayerStatsFold = EMPTY_FOLD;
    let logs: AttemptLog[] = [];
    try {
      logs = await gatherLocalAttemptLogs();
      local = foldLocalPlayerStats(logs);
    } catch { /* IndexedDB unavailable — local stays empty */ }
    try {
      await flushAll({ playerId: currentPlayerId(), api });
    } catch { /* offline — local fold still carries the truth */ }
    let me: Me | null = null;
    let server: PlayerStatsFold | null = null;
    let purchases = 0;
    let error: 'auth' | 'network' | null = null;
    try {
      const [meRes, statsRes] = await Promise.all([api.me(), api.myStats()]);
      me = meRes;
      server = { balance: statsRes.balance, completed_quest_ids: statsRes.completed_quest_ids };
      purchases = statsRes.grants_count;
    } catch (err) {
      const status = err instanceof ApiError ? err.status : null;
      error = status === 401 || status === 403 ? 'auth' : 'network';
    }
    let titles: Record<string, string> = {};
    try {
      const quests = await api.listQuests();
      titles = Object.fromEntries(quests.map((q) => [q.quest_id, q.name]));
    } catch { /* keep raw ids */ }
    setData({ source: 'ready', me, server, local, logs, titles, purchases, error });
  };

  useEffect(() => {
    let cancelled = false;
    void load().then(() => { if (cancelled) return; });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const ready = data.source === 'ready' ? data : null;
  const merged = mergeProfileStats(ready?.server ?? null, ready?.local ?? EMPTY_FOLD);
  const details = completedQuestDetails(ready?.logs ?? []);
  const balance = merged.balance;
  const completedIds = merged.completedIds;

  const registered = ready ? (ready.me ? ready.me.registered : !!session) : false;
  const nameLabel = ready?.me?.display_name ?? session?.display_name ?? null;
  const emailLabel = ready?.me?.email ?? session?.email ?? null;
  const unconfirmed = registered && !!ready?.me && ready.me.email_confirmed_at == null;

  const errorNote =
    ready?.error === 'auth'
      ? 'Сессия устарела — войдите снова, чтобы свести данные со всех устройств. Показаны данные этого устройства.'
      : ready?.error === 'network'
        ? 'Не удалось связаться с сервером — показаны данные этого устройства.'
        : null;

  const logout = () => {
    void logoutAndReset().finally(() => { window.location.href = '/'; });
  };

  return (
    <div className="site min-h-screen" style={{ background: '#fff', display: 'flex', flexDirection: 'column' }}>
      <SiteHeader />
      <main className="co-wrap">
        <h2 className="co-title">Мой профиль</h2>
        {errorNote && <p className="pf-note" style={{ color: 'var(--amber)' }}>{errorNote}</p>}

        {/* §6.3 soft email confirmation — dismissable amber banner */}
        {unconfirmed && banner && (
          <div className="pf-confirm-banner">
            <span>Подтвердите почту — отправили письмо{emailLabel ? ` на ${emailLabel}` : ''}</span>
            <span className="pf-confirm-banner__actions">
              <button
                type="button"
                onClick={() => void api.authResendConfirm().then(
                  () => toast('Письмо отправлено ещё раз'),
                  () => toast('Не удалось отправить письмо — попробуйте позже'),
                )}
              >
                Ещё раз
              </button>
              <button type="button" aria-label="Скрыть" onClick={() => setBanner(false)}>✕</button>
            </span>
          </div>
        )}

        {/* §7.5 anonymous nudge — only when there is something to lose */}
        {ready && !registered && (balance > 0 || ready.purchases > 0) && (
          <div className="card pf-nudge">
            <div className="pf-nudge__head">
              <span className="pf-nudge__avatar" aria-hidden>?</span>
              <span>
                <b>Вы играете без аккаунта</b>
                <small>всё хранится только на этом устройстве</small>
              </span>
            </div>
            <p className="pf-nudge__body">
              У вас <b>{balance} {plural(balance, 'монета', 'монеты', 'монет')}</b> и{' '}
              <b>{ready.purchases} {plural(ready.purchases, 'купленный квест', 'купленных квеста', 'купленных квестов')}</b>.
              Смените браузер или телефон — они потеряются. Привяжите почту, и всё сохранится.
            </p>
            <Link className="btn btn--block" href="/auth">Создать аккаунт</Link>
            <Link className="pf-nudge__alt" href="/auth">У меня уже есть аккаунт</Link>
          </div>
        )}

        <div className="pf-grid">
          <div className="pf-col">
            <div className="card pf-card pf-identity">
              <span className="pf-avatar" aria-hidden>{(nameLabel ?? emailLabel ?? '?')[0]?.toUpperCase()}</span>
              <span className="pf-identity__body">
                <b>{nameLabel ?? (registered ? emailLabel : 'Анонимный игрок')}</b>
                {registered && <small>{emailLabel}</small>}
                {!registered && <small>играете без аккаунта · <Link className="link" href="/auth">войти</Link></small>}
              </span>
            </div>

            {/* §7.1 honest tiles: coins + completed. No fabricated «рейтинг». */}
            <div className="pf-tiles">
              <div className="card pf-tile">
                <b>{balance}</b>
                <span>{plural(balance, 'монета на балансе', 'монеты на балансе', 'монет на балансе')}</span>
              </div>
              <div className="card pf-tile">
                <b>{completedIds.length}</b>
                <span>{plural(completedIds.length, 'квест пройден', 'квеста пройдено', 'квестов пройдено')}</span>
              </div>
            </div>

            <div className="card pf-card">
              <h4 className="pf-card__head">Пройденные квесты</h4>
              {completedIds.length > 0 ? (
                completedIds.map((id) => {
                  const d = details[id];
                  return (
                    <div className="pf-done-row" key={id}>
                      <span className="pf-done-row__body">
                        <b>{ready?.titles[id] ?? id}</b>
                        {d?.completed_at && <small>{fmtDate(d.completed_at)}</small>}
                      </span>
                      <Stars n={d?.rating ?? 0} />
                    </div>
                  );
                })
              ) : (
                <p className="pf-note">
                  {data.source === 'loading' ? 'Загружаем профиль…' : 'Пока нет пройденных квестов.'}
                </p>
              )}
              <Link className="btn btn--secondary btn--md" href="/my-quests">Все мои квесты</Link>
            </div>
          </div>

          {/* §7.3 account block */}
          {registered && (
            <div className="pf-col">
              <div className="card pf-card pf-account">
                <h4 className="pf-card__head">Аккаунт</h4>
                <button className="pf-account__row" type="button" onClick={() => setSheet('name')}>
                  Изменить имя <span aria-hidden>›</span>
                </button>
                <button className="pf-account__row" type="button" onClick={() => setSheet('password')}>
                  Сменить пароль <span aria-hidden>›</span>
                </button>
                {/* §2.4/§5: the GLOBAL app install lives here now */}
                <div className="pf-account__install"><InstallPrompt /></div>
                <button className="pf-account__row" type="button" onClick={logout}>Выйти</button>
                <button className="pf-account__row pf-account__row--danger" type="button" onClick={() => setSheet('delete')}>
                  Удалить аккаунт
                </button>
              </div>
            </div>
          )}
        </div>
      </main>
      <SiteFooter />

      {sheet === 'name' && (
        <NameSheet current={nameLabel} onClose={() => setSheet(null)} onSaved={() => { setSheet(null); reload(); }} />
      )}
      {sheet === 'password' && <PasswordSheet email={emailLabel} onClose={() => setSheet(null)} />}
      {sheet === 'delete' && (
        <DeleteSheet
          purchases={ready?.purchases ?? 0}
          balance={balance}
          onClose={() => setSheet(null)}
          onDeleted={() => {
            void logoutAndReset().finally(() => router.push('/'));
          }}
        />
      )}
    </div>
  );
}

function NameSheet({ current, onClose, onSaved }: { current: string | null; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(current ?? '');
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      await api.authSetDisplayName(name.trim() || null);
      toast('Имя сохранено');
      onSaved();
    } catch {
      toast('Не удалось сохранить имя — попробуйте позже');
      setBusy(false);
    }
  };
  return (
    <div className="psheet__ovl" onClick={onClose}>
      <div className="psheet" role="dialog" aria-label="Изменить имя" onClick={(e) => e.stopPropagation()}>
        <span className="psheet__grabber" aria-hidden />
        <b className="pf-sheet__title">Изменить имя</b>
        <input className="input" aria-label="Имя" placeholder="Как вас называть?" value={name} onChange={(e) => setName(e.target.value)} />
        <button className="btn btn--block btn--md" type="button" disabled={busy} onClick={() => void save()}>Сохранить</button>
        <button className="psheet__cancel" type="button" onClick={onClose}>Отмена</button>
      </div>
    </div>
  );
}

function PasswordSheet({ email, onClose }: { email: string | null; onClose: () => void }) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [showCur, setShowCur] = useState(false);
  const [showNew, setShowNew] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    if (next.length < 8) {
      setError('Новый пароль — минимум 8 символов');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.authChangePassword({ current_password: current, new_password: next });
      toast('Пароль изменён');
      onClose();
    } catch (e) {
      const status = (e as { status?: number })?.status;
      setError(status === 401 ? 'Неверный текущий пароль' : 'Сервер недоступен — попробуйте позже');
      setBusy(false);
    }
  };
  return (
    <div className="psheet__ovl" onClick={onClose}>
      <div className="psheet" role="dialog" aria-label="Сменить пароль" onClick={(e) => e.stopPropagation()}>
        <span className="psheet__grabber" aria-hidden />
        <b className="pf-sheet__title">Сменить пароль</b>
        <span className="af-field__wrap">
          <input className="af-field__input" type={showCur ? 'text' : 'password'} aria-label="Текущий пароль" placeholder="текущий пароль" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} />
          <button className="af-field__show" type="button" onClick={() => setShowCur((v) => !v)}>{showCur ? 'Скрыть' : 'Показать'}</button>
        </span>
        <span className="af-field__wrap">
          <input className="af-field__input" type={showNew ? 'text' : 'password'} aria-label="Новый пароль" placeholder="новый пароль — минимум 8" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} />
          <button className="af-field__show" type="button" onClick={() => setShowNew((v) => !v)}>{showNew ? 'Скрыть' : 'Показать'}</button>
        </span>
        {error && <p className="af-error">{error}</p>}
        <button className="btn btn--block btn--md" type="button" disabled={busy} onClick={() => void save()}>Сохранить</button>
        {/* §7.3: recovery by mail for a forgotten current password (needs re-login) */}
        <Link className="pf-sheet__alt" href="/auth" onClick={() => { void api; }}>
          Не помню текущий — восстановить по почте{email ? '' : ''}
        </Link>
        <button className="psheet__cancel" type="button" onClick={onClose}>Отмена</button>
      </div>
    </div>
  );
}

function DeleteSheet({ purchases, balance, onClose, onDeleted }: {
  purchases: number;
  balance: number;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const [checked, setChecked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [blocked, setBlocked] = useState<string | null>(null);
  const run = async () => {
    setBusy(true);
    try {
      await api.authDeleteAccount();
      onDeleted();
    } catch (e) {
      const err = e as { status?: number; message?: string };
      if (err.status === 409) {
        // The server blocks authors with quests still on sale; its message
        // carries the honest count («published quests block deletion: N»).
        const m = /(\d+)/.exec(err.message ?? '');
        const n = m ? Number(m[1]) : 0;
        setBlocked(
          n > 0
            ? `Сначала снимите с публикации ${n} ${plural(n, 'квест', 'квеста', 'квестов')}`
            : 'Сначала снимите с публикации опубликованные квесты',
        );
      } else {
        toast('Не удалось удалить аккаунт — попробуйте позже');
      }
      setBusy(false);
    }
  };
  return (
    <div className="psheet__ovl" onClick={onClose}>
      <div className="psheet" role="alertdialog" aria-label="Удаление аккаунта" onClick={(e) => e.stopPropagation()}>
        <span className="psheet__grabber" aria-hidden />
        <b className="pf-sheet__title">Удалить аккаунт навсегда?</b>
        <div className="pf-delete__list">
          <span><i>✕</i>{purchases} {plural(purchases, 'купленный квест станет недоступен', 'купленных квеста станут недоступны', 'купленных квестов станут недоступны')}</span>
          <span><i>✕</i>{balance} {plural(balance, 'монета и весь прогресс исчезнут', 'монеты и весь прогресс исчезнут', 'монет и весь прогресс исчезнут')}</span>
          <span><i>✕</i>Отменить удаление нельзя</span>
        </div>
        <label className="pf-delete__consent">
          <input type="checkbox" checked={checked} onChange={(e) => setChecked(e.target.checked)} />
          <span>Я понимаю, что данные будут удалены безвозвратно</span>
        </label>
        {blocked && <p className="af-error">{blocked}</p>}
        <button className="btn btn--danger btn--block btn--md" type="button" disabled={!checked || busy} onClick={() => void run()}>
          Удалить навсегда
        </button>
        <button className="psheet__cancel" type="button" onClick={onClose}>Отмена</button>
      </div>
    </div>
  );
}
