'use client';

import React, { useEffect, useMemo, useState } from 'react';
import { api, apiErrorMessage, type AdminAfishaResponse } from '../../../lib/api';
import {
  FORM_FIELDS,
  STATUS_FILTERS,
  STATUS_LABEL,
  countByFilter,
  draftOf,
  editedLabel,
  filterLabel,
  kindLabel,
  reportText,
  saveBodyOf,
  whenLabel,
  type AdminAfishaWire,
  type AfishaDraft,
  type AfishaStatus,
} from '../../../lib/admin-afisha';
import { pluralCount } from '../../../lib/ru';
import { Input, Textarea } from '../../components/ui';
import { AdminPageHead, AdminToast, useToast } from '../ui';

/**
 * Admin · Афиша: the announcements the site reads from the Telegram channel.
 *
 * The admin publishes posts in the channel as always and adds #hiking or
 * #quest; the backend reads the channel every 10 minutes (afisha_reader.rs).
 * Here: the channel and the mail for the reader's letters, the switch of the
 * public pages, «Проверить канал» now, a post by its link, the archive, and
 * per announcement a correction form and «Скрыть» / «Показать». Every action
 * answers with the whole page, which the page adopts as is.
 */

/** Pages of the archive search at most — 20 posts each. */
const ARCHIVE_MAX_PAGES = 100;

export default function AdminAfishaPage() {
  const [page, setPage] = useState<AdminAfishaResponse | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [filter, setFilter] = useState<'all' | AfishaStatus>('all');
  const [editing, setEditing] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const { toast, showToast } = useToast();
  const [toastError, setToastError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api
      .adminAfisha()
      .then((p) => {
        if (!cancelled) setPage(p);
      })
      .catch(() => {
        if (!cancelled) setLoadError(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const notify = (text: string, error = false) => {
    setToastError(error);
    showToast(text);
  };

  /** Run one action: adopt the page it answers with, or toast the server's reason. */
  const run = async (work: () => Promise<AdminAfishaResponse>, done?: (p: AdminAfishaResponse) => string) => {
    setBusy(true);
    try {
      const next = await work();
      setPage(next);
      if (done) notify(done(next));
      return true;
    } catch (err) {
      notify(apiErrorMessage(err, 'Не получилось — попробуйте ещё раз'), true);
      return false;
    } finally {
      setBusy(false);
    }
  };

  const events = useMemo(() => page?.events ?? [], [page]);
  const counts = useMemo(() => countByFilter(events), [events]);
  const shown = filter === 'all' ? events : events.filter((e) => e.status === filter);

  const sync = () => run(() => api.adminAfishaSync(), (p) => (p.report ? reportText(p.report) : 'Канал прочитан'));

  const loadArchive = async () => {
    setBusy(true);
    let before: number | null = null;
    let created = 0;
    try {
      for (let pages = 0; pages < ARCHIVE_MAX_PAGES; pages += 1) {
        const next: AdminAfishaResponse = await api.adminAfishaArchive({ before });
        setPage(next);
        created += next.report?.created ?? 0;
        setProgress(`Загружаем архив… добавлено ${created}`);
        before = next.report?.next_before ?? null;
        if (before === null) break;
      }
      notify(`Архив загружен: ${pluralCount(created, 'новый анонс', 'новых анонса', 'новых анонсов')}`);
    } catch (err) {
      notify(apiErrorMessage(err, 'Не удалось загрузить архив'), true);
    } finally {
      setProgress(null);
      setBusy(false);
    }
  };

  if (loadError) {
    return (
      <main className="ap-main">
        <AdminPageHead eyebrow="АФИША" title="Анонсы из канала" />
        <div className="aaf-empty">Не удалось загрузить афишу. Проверьте соединение и обновите страницу.</div>
      </main>
    );
  }

  return (
    <>
      <main className="ap-main">
        <AdminPageHead
          eyebrow="АФИША"
          title="Анонсы из канала"
          lede="Посты канала с хештегом #hiking (прогулка) или #quest (групповой квест) сайт забирает сам каждые 10 минут. Здесь — настройки, ручная проверка и правка анонсов."
        >
          <button
            type="button"
            className="btn btn--sm aaf-head-btn"
            disabled={!page?.channel || busy}
            onClick={() => void sync()}
          >
            Проверить канал
          </button>
        </AdminPageHead>

        {!page ? (
          <div className="aaf-empty">Загружаем…</div>
        ) : (
          <>
            <SettingsPanel page={page} busy={busy} run={run} />
            <ToolsPanel
              page={page}
              busy={busy}
              progress={progress}
              onImport={(url) =>
                run(
                  () => api.adminAfishaImport({ url }),
                  (p) => (p.report?.created ? 'Пост добавлен в афишу' : 'Пост обновлён'),
                )
              }
              onArchive={() => void loadArchive()}
            />

            <div className="aaf-filters" role="tablist" aria-label="Статус">
              {STATUS_FILTERS.map((f) => (
                <button
                  key={f}
                  type="button"
                  role="tab"
                  aria-selected={filter === f}
                  className={`aaf-filter${filter === f ? ' is-active' : ''}`}
                  onClick={() => setFilter(f)}
                >
                  {filterLabel(f)} <span>{counts[f]}</span>
                </button>
              ))}
            </div>

            <div className="aaf-list">
              {shown.length === 0 ? (
                <div className="aaf-empty">
                  {events.length === 0
                    ? 'Анонсов пока нет. Укажите канал и нажмите «Проверить канал».'
                    : 'В этом разделе пусто.'}
                </div>
              ) : (
                shown.map((event) =>
                  editing === event.post_id ? (
                    <EventForm
                      key={event.post_id}
                      event={event}
                      busy={busy}
                      onCancel={() => setEditing(null)}
                      onSave={async (draft) => {
                        const ok = await run(() => api.adminAfishaSave(saveBodyOf(event.post_id, draft)), () => 'Сохранено');
                        if (ok) setEditing(null);
                      }}
                    />
                  ) : (
                    <EventRow
                      key={event.post_id}
                      event={event}
                      disabled={busy || editing !== null}
                      onEdit={() => setEditing(event.post_id)}
                      onVisibility={(hidden) =>
                        void run(
                          () => api.adminAfishaVisibility({ post_id: event.post_id, hidden }),
                          () => (hidden ? 'Анонс скрыт' : 'Анонс снова на сайте'),
                        )
                      }
                    />
                  ),
                )
              )}
            </div>
          </>
        )}
      </main>
      {toast && <AdminToast text={toast} error={toastError} />}
    </>
  );
}

type Run = (
  work: () => Promise<AdminAfishaResponse>,
  done?: (p: AdminAfishaResponse) => string,
) => Promise<boolean>;

/** The channel, the mail for the reader's letters and the switch of the public pages. */
function SettingsPanel({ page, busy, run }: { page: AdminAfishaResponse; busy: boolean; run: Run }) {
  const [channel, setChannel] = useState(page.channel ?? '');
  const [email, setEmail] = useState(page.admin_email ?? '');

  const save = () =>
    run(async () => {
      await api.adminSetSetting('afisha_channel', channel);
      await api.adminSetSetting('afisha_admin_email', email);
      return api.adminAfisha();
    }, (p) => (p.channel ? 'Настройки сохранены' : 'Сохранено, но канал не распознан — нужно имя вида serbia_progulki'));

  const toggle = () =>
    run(async () => {
      await api.adminSetFeature('afisha', !page.enabled);
      return api.adminAfisha();
    }, (p) => (p.enabled ? 'Афиша включена на сайте' : 'Афиша выключена'));

  return (
    <section className="aaf-panel" aria-label="Настройки">
      <div className="aaf-settings">
        <label className="aaf-field">
          <span>Канал</span>
          <Input value={channel} placeholder="serbia_progulki" onChange={(e) => setChannel(e.target.value)} />
        </label>
        <label className="aaf-field">
          <span>Почта для писем</span>
          <Input
            type="email"
            value={email}
            placeholder="admin@example.com"
            onChange={(e) => setEmail(e.target.value)}
          />
        </label>
        <button type="button" className="btn btn--secondary btn--sm" disabled={busy} onClick={() => void save()}>
          Сохранить
        </button>
      </div>
      <p className="aaf-hint">
        На почту приходят письма о постах, которые не удалось разобрать, об удалённых постах и о сбоях чтения канала.
      </p>
      <div className="aaf-state">
        <span className={`aaf-dot${page.enabled ? ' is-on' : ''}`} aria-hidden />
        <span>
          Страницы /afisha на сайте: <b>{page.enabled ? 'включены' : 'выключены'}</b>
        </span>
        <button type="button" className="link" disabled={busy} onClick={() => void toggle()}>
          {page.enabled ? 'Выключить' : 'Включить'}
        </button>
      </div>
      <p className="aaf-hint">
        {page.running
          ? 'Канал читается прямо сейчас…'
          : page.last_run
            ? `Последняя проверка: ${new Date(page.last_run).toLocaleString('ru-RU')}`
            : 'Канал ещё не проверялся с последнего запуска сервера.'}
        {page.last_error && <span className="aaf-error"> Ошибка: {page.last_error}</span>}
      </p>
    </section>
  );
}

/** A post by its link, and the archive. */
function ToolsPanel({
  page,
  busy,
  progress,
  onImport,
  onArchive,
}: {
  page: AdminAfishaResponse;
  busy: boolean;
  progress: string | null;
  onImport: (url: string) => Promise<boolean>;
  onArchive: () => void;
}) {
  const [url, setUrl] = useState('');
  const disabled = busy || !page.channel;
  return (
    <section className="aaf-panel" aria-label="Импорт">
      <div className="aaf-settings">
        <label className="aaf-field aaf-field--wide">
          <span>Импорт по ссылке</span>
          <Input
            value={url}
            placeholder={`https://t.me/${page.channel ?? 'serbia_progulki'}/1110`}
            onChange={(e) => setUrl(e.target.value)}
          />
        </label>
        <button
          type="button"
          className="btn btn--secondary btn--sm"
          disabled={disabled || !url.trim()}
          onClick={() => void onImport(url.trim()).then((ok) => ok && setUrl(''))}
        >
          Добавить
        </button>
      </div>
      <p className="aaf-hint">
        Для поста без хештега или для старого анонса. Пост без хештега получит тип по тексту — его можно поменять.
      </p>
      <div className="aaf-state">
        <button type="button" className="btn btn--quiet btn--sm" disabled={disabled} onClick={onArchive}>
          Загрузить архив
        </button>
        <span className="aaf-hint">
          {progress ?? 'Все прошедшие анонсы канала — лента листается до самого начала. Уже загруженные посты не меняются.'}
        </span>
      </div>
    </section>
  );
}

function EventRow({
  event,
  disabled,
  onEdit,
  onVisibility,
}: {
  event: AdminAfishaWire;
  disabled: boolean;
  onEdit: () => void;
  onVisibility: (hidden: boolean) => void;
}) {
  const edited = editedLabel(event);
  return (
    <div className="aaf-row">
      <div className="aaf-row__info">
        <div className="aaf-row__top">
          <span className={`aaf-status aaf-status--${event.status}`}>{STATUS_LABEL[event.status]}</span>
          <span>{kindLabel(event.kind)}</span>
          <span>пост {event.post_id}</span>
          {event.past && <span>прошёл</span>}
        </div>
        <div className="aaf-row__title">{event.fields.title || 'Без названия'}</div>
        <div className="aaf-row__meta">
          {whenLabel(event)}
          {event.fields.city ? ` · ${event.fields.city}` : ''}
          {event.clicks > 0 ? ` · нажали «Записаться»: ${event.clicks}` : ''}
        </div>
        {event.problem && event.status === 'draft' && <div className="aaf-row__problem">Не хватает: {event.problem.replace(/^нет /, '')}</div>}
        {edited && <div className="aaf-row__edited">Не меняется при правке поста: {edited}</div>}
      </div>
      <div className="aaf-row__actions">
        {event.status === 'published' && (
          <a className="link" href={`/afisha/${event.slug}`} target="_blank" rel="noopener">
            Страница
          </a>
        )}
        <a className="link" href={event.post_url} target="_blank" rel="noopener">
          Пост
        </a>
        <button type="button" className="btn btn--quiet btn--sm" disabled={disabled} onClick={onEdit}>
          Править
        </button>
        {event.status === 'hidden' ? (
          <button type="button" className="btn btn--quiet btn--sm" disabled={disabled} onClick={() => onVisibility(false)}>
            Показать
          </button>
        ) : (
          event.status !== 'removed' && (
            <button type="button" className="btn btn--quiet btn--sm" disabled={disabled} onClick={() => onVisibility(true)}>
              Скрыть
            </button>
          )
        )}
      </div>
    </div>
  );
}

function EventForm({
  event,
  busy,
  onCancel,
  onSave,
}: {
  event: AdminAfishaWire;
  busy: boolean;
  onCancel: () => void;
  onSave: (draft: AfishaDraft) => void;
}) {
  const [draft, setDraft] = useState<AfishaDraft>(() => draftOf(event));
  const set = (key: keyof AfishaDraft['fields'], value: string) =>
    setDraft((d) => ({ ...d, fields: { ...d.fields, [key]: value } }));
  return (
    <form
      className="aaf-form"
      aria-label={`Анонс ${event.post_id}`}
      onSubmit={(e) => {
        e.preventDefault();
        onSave(draft);
      }}
    >
      <div className="aaf-form__title">Пост {event.post_id}</div>
      <p className="aaf-hint">
        Исправленные здесь поля не перезапишутся, даже если пост потом поправят в канале.
      </p>
      <label className="aaf-field">
        <span>Тип</span>
        <select
          className="input"
          value={draft.kind}
          onChange={(e) => setDraft((d) => ({ ...d, kind: e.target.value as AfishaDraft['kind'] }))}
        >
          <option value="">Не указан (не публикуется)</option>
          <option value="hiking">Прогулка</option>
          <option value="quest">Групповой квест</option>
        </select>
      </label>
      <div className="aaf-form__grid">
        {FORM_FIELDS.map(({ key, label, input }) => (
          <label key={key} className={`aaf-field${input === 'textarea' || key === 'title' ? ' aaf-field--wide' : ''}`}>
            <span>{label}</span>
            {input === 'textarea' ? (
              <Textarea rows={5} value={draft.fields[key]} onChange={(e) => set(key, e.target.value)} />
            ) : (
              <Input type={input} value={draft.fields[key]} onChange={(e) => set(key, e.target.value)} />
            )}
          </label>
        ))}
      </div>
      <div className="aaf-form__actions">
        <button type="button" className="btn btn--quiet btn--sm" disabled={busy} onClick={onCancel}>
          Отмена
        </button>
        <button type="submit" className="btn btn--sm" disabled={busy || !draft.fields.title.trim()}>
          Сохранить
        </button>
      </div>
    </form>
  );
}
