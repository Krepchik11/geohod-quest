'use client';

import React, { useDeferredValue, useEffect, useState } from 'react';
import Link from 'next/link';
import { api, type AdminReviewWire } from '../../../lib/api';
import {
  DEFAULT_REVIEWS_QUERY,
  REVIEW_SORTS,
  REVIEW_TEXTS,
  REVIEW_VIEWS,
  formatAverage,
  identityBadge,
  identityName,
  markWho,
  moderationDate,
  parseReviewsQuery,
  questAverage,
  questSummary,
  reviewFacets,
  reviewQuestOptions,
  reviewStatus,
  serializeReviewsQuery,
  type QuestSummary,
  type ReviewSort,
  type ReviewStatus,
  type ReviewsQuery,
} from '../../../lib/admin-moderation';
import { refreshModerationCounts } from '../../../lib/moderation-counts';
import { plural, pluralCount } from '../../../lib/ru';
import { useMe } from '../../../lib/use-me';
import { AdminConfirmSheet, AdminPageHead, AdminToast, useToast } from '../ui';
import { ContactRow } from '../moderation-ui';

/**
 * Admin · Отзывы (content-moderation). Every quest rating — star-only included —
 * as one row per (player, quest), with a per-(player, quest) hide that drops the
 * rating from the quest page and its average. The hide confirm previews the quest
 * average before→after with the SAME per-player, hide-aware fold the server uses,
 * so the preview can never disagree with what ships.
 *
 * Filters, search and sort live in the URL (replaceState — a filter click is not
 * a history step), so a reload or a shared link opens the same list. The list
 * renders a page at a time; any change of what is listed starts from the top.
 *
 * «Проверено» is shared by all admins: a review is new until one of them checks
 * it, and new again once the player changes it. Hiding or showing a review checks
 * it too. With nothing in the link saying which view, the page opens on «Новые»
 * while anything waits; every action refreshes the menu counters.
 */

const PAGE = 50;

const RATING_CHIPS: ReadonlyArray<{ value: number; label: string }> = [
  { value: 0, label: 'Все' },
  { value: 5, label: '5★' },
  { value: 4, label: '4★' },
  { value: 3, label: '3★' },
  { value: 2, label: '2★' },
  { value: 1, label: '1★' },
];

/** This admin's own mark, stamped now — until the next load names them server-side. */
function ownMark(byId: string | undefined, byName: string | null) {
  return {
    at: Math.floor(Date.now() / 1000),
    by_id: byId ?? 'ops-token',
    by_name: byName ?? 'вы',
  };
}

/** Stable key identifying one (player, quest) review across state updates. */
function reviewKey(r: AdminReviewWire): string {
  return `${r.identity.user_id} ${r.quest_id}`;
}

export default function AdminReviewsPage() {
  const [reviews, setReviews] = useState<AdminReviewWire[] | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [query, setQuery] = useState<ReviewsQuery>(() =>
    typeof window === 'undefined'
      ? DEFAULT_REVIEWS_QUERY
      : parseReviewsQuery(window.location.search),
  );
  const [confirm, setConfirm] = useState<AdminReviewWire | null>(null);
  // «Отметить все проверенными» — the reviews it covers, while its confirm is open.
  const [bulk, setBulk] = useState<AdminReviewWire[] | null>(null);
  const [busy, setBusy] = useState(false);
  // How many pages are open — for the list it was opened on; a new list starts at one.
  const [more, setMore] = useState({ list: '', pages: 1 });
  const { toast, showToast } = useToast();
  const { session, displayName } = useMe();

  useEffect(() => {
    let cancelled = false;
    void api
      .adminListReviews()
      .then((r) => {
        if (cancelled) return;
        setReviews(r.reviews);
        // Nothing in the link says which view: open on «Новые» while anything waits.
        if (
          !new URLSearchParams(window.location.search).has('view') &&
          r.reviews.some((x) => reviewStatus(x) !== 'checked')
        ) {
          const next = { ...parseReviewsQuery(window.location.search), view: 'new' as const };
          setQuery(next);
          window.history.replaceState(
            null,
            '',
            `${window.location.pathname}${serializeReviewsQuery(next)}`,
          );
        }
      })
      .catch(() => {
        if (!cancelled) setLoadError(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const myMark = () => ownMark(session?.user_id, displayName);
  const checkedNow = (r: AdminReviewWire): AdminReviewWire => ({
    ...r,
    check: { through: r.changed_at, ...myMark() },
  });
  const patchReviews = (
    targets: readonly AdminReviewWire[],
    patch: (r: AdminReviewWire) => AdminReviewWire,
  ) => {
    const keys = new Set(targets.map(reviewKey));
    setReviews((rs) => (rs ?? []).map((r) => (keys.has(reviewKey(r)) ? patch(r) : r)));
  };

  const applyHide = async () => {
    if (!confirm) return;
    setBusy(true);
    try {
      await api.adminHideReview({
        user_id: confirm.identity.user_id,
        quest_id: confirm.quest_id,
      });
      // Hiding is deciding — the server checks the review too.
      patchReviews([confirm], (r) => ({ ...checkedNow(r), hidden: true, hide: myMark() }));
      refreshModerationCounts();
      setConfirm(null);
      showToast('Отзыв скрыт и исключён из оценки');
    } catch {
      showToast('Не удалось скрыть отзыв');
    } finally {
      setBusy(false);
    }
  };

  const unhide = async (r: AdminReviewWire) => {
    try {
      await api.adminUnhideReview({ user_id: r.identity.user_id, quest_id: r.quest_id });
      patchReviews([r], (x) => ({ ...checkedNow(x), hidden: false, hide: null }));
      refreshModerationCounts();
      showToast('Отзыв снова виден');
    } catch {
      showToast('Не удалось показать отзыв');
    }
  };

  /** «Проверено» at the versions shown — one review or the whole list. */
  const check = async (targets: readonly AdminReviewWire[]) => {
    try {
      await api.adminCheckReviews({
        reviews: targets.map((r) => ({
          user_id: r.identity.user_id,
          quest_id: r.quest_id,
          through: r.changed_at,
        })),
      });
      patchReviews(targets, checkedNow);
      refreshModerationCounts();
      showToast(`Проверено: ${targets.length}`);
    } catch {
      showToast('Не удалось отметить проверенным');
    }
  };

  const applyBulk = async () => {
    if (!bulk) return;
    setBusy(true);
    await check(bulk);
    setBusy(false);
    setBulk(null);
  };

  const copyId = (id: string) =>
    void Promise.resolve()
      .then(() => navigator.clipboard.writeText(id))
      .then(
        () => showToast('ID скопирован'),
        () => showToast('Не удалось скопировать ID'),
      );

  // A link to a quest that has no ratings (any more) shows every quest.
  const q =
    reviews && query.quest !== 'all' && !reviews.some((r) => r.quest_id === query.quest)
      ? { ...query, quest: 'all' }
      : query;
  const update = (patch: Partial<ReviewsQuery>) => {
    const next = { ...q, ...patch };
    setQuery(next);
    window.history.replaceState(
      null,
      '',
      `${window.location.pathname}${serializeReviewsQuery(next)}`,
    );
  };

  // Typing stays instant; the list catches up with the search a beat later.
  const search = useDeferredValue(q.q);
  const listed = search === q.q ? q : { ...q, q: search };
  const facets = reviewFacets(reviews ?? [], listed);
  const questOptions = reviewQuestOptions(reviews ?? [], facets.quests);
  const summary = reviews && q.quest !== 'all' ? questSummary(reviews, q.quest) : null;
  const shown = facets.list;
  const listKey = serializeReviewsQuery(listed);
  const pages = more.list === listKey ? more.pages : 1;
  const page = shown.slice(0, pages * PAGE);
  const rest = shown.length - page.length;

  const before = confirm ? questAverage(reviews ?? [], confirm.quest_id) : null;
  const after = confirm
    ? questAverage(reviews ?? [], confirm.quest_id, confirm.identity.user_id)
    : null;

  return (
    <>
    <main className="ap-main">
      <AdminPageHead
        eyebrow="МОДЕРАЦИЯ"
        title="Отзывы"
        lede="Все оценки квестов, включая оценки без текста. Скройте недостоверные — они исчезнут со страницы квеста и из средней оценки."
      />

      {loadError ? (
        <div className="amod-error">
          Не удалось загрузить отзывы. Обновите страницу позже.
        </div>
      ) : !reviews ? (
        <div className="amod-loading">
          <span className="ash-spinner" aria-label="Загрузка" />
        </div>
      ) : (
        <>
          <div className="amod-filters">
            {/* The Пользователи search box — one look for both admin searches. */}
            <div className="au-search amod-search">
              <span className="au-search-icon" aria-hidden />
              <input
                type="text"
                className="au-search-input"
                value={q.q}
                onChange={(e) => update({ q: e.target.value })}
                placeholder="Текст, имя, почта, @telegram или ID…"
                aria-label="Поиск по отзывам"
                autoComplete="off"
                spellCheck={false}
              />
              {q.q.length > 0 && (
                <button
                  type="button"
                  className="au-clear"
                  aria-label="Очистить поиск"
                  onClick={() => update({ q: '' })}
                >
                  ✕
                </button>
              )}
            </div>
            <span className="amod-filters__end">
              <span className="amod-filters__label">СОРТИРОВКА</span>
              <select
                className="amod-select"
                aria-label="Сортировка"
                value={q.sort}
                onChange={(e) => update({ sort: e.target.value as ReviewSort })}
              >
                {REVIEW_SORTS.map((s) => (
                  <option key={s.key} value={s.key}>
                    {s.label}
                  </option>
                ))}
              </select>
            </span>
          </div>
          <div className="amod-filters">
            <span className="amod-filters__label">ПОКАЗАТЬ</span>
            {REVIEW_VIEWS.map((v) => (
              <button
                key={v.key}
                type="button"
                className={`amod-chip${q.view === v.key ? ' is-on' : ''}`}
                aria-pressed={q.view === v.key}
                onClick={() => update({ view: v.key })}
              >
                {v.label} · {facets.views[v.key]}
              </button>
            ))}
            <span className="amod-filters__label">ТЕКСТ</span>
            {REVIEW_TEXTS.map((t) => {
              const on = q.text === t.key;
              const count = t.key === 'all' ? null : facets.texts[t.key];
              return (
                <button
                  key={t.key}
                  type="button"
                  className={`amod-chip${on ? ' is-on' : ''}`}
                  aria-pressed={on}
                  disabled={count === 0 && !on}
                  onClick={() => update({ text: t.key })}
                >
                  {count === null ? t.label : `${t.label} · ${count}`}
                </button>
              );
            })}
          </div>
          <div className="amod-filters">
            <span className="amod-filters__label">КВЕСТ</span>
            <select
              className="amod-select"
              aria-label="Квест"
              value={q.quest}
              onChange={(e) => update({ quest: e.target.value })}
            >
              {questOptions.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
            <span className="amod-filters__label">ОЦЕНКА</span>
            {RATING_CHIPS.map((chip) => {
              const on = q.rating === chip.value;
              const count = chip.value === 0 ? null : facets.ratings[chip.value];
              return (
                <button
                  key={chip.value}
                  type="button"
                  className={`amod-chip${on ? ' is-on' : ''}`}
                  aria-pressed={on}
                  disabled={count === 0 && !on}
                  onClick={() => update({ rating: chip.value })}
                >
                  {count === null ? chip.label : `${chip.label} · ${count}`}
                </button>
              );
            })}
          </div>

          {summary && <QuestSummaryCard summary={summary} />}

          <div className="amod-count">
            <span>
              {shown.length} {plural(shown.length, 'запись', 'записи', 'записей')}
            </span>
            {q.view === 'new' && shown.length > 0 && (
              <button
                type="button"
                className="amod-btn amod-btn--resolve"
                onClick={() => setBulk(shown)}
              >
                Отметить все проверенными · {shown.length}
              </button>
            )}
          </div>

          <div className="amod-banner" role="note">
            <span aria-hidden>ⓘ</span>
            <span>
              Скрытый отзыв исчезает со страницы квеста и не учитывается в средней оценке.
              Скрытие привязано к игроку и квесту — повторная оценка того же игрока его не
              вернёт.
            </span>
          </div>

          <div className="amod-list">
            {page.map((r) => (
              <ReviewCard
                key={reviewKey(r)}
                review={r}
                status={reviewStatus(r)}
                onCheck={() => void check([r])}
                onHide={() => setConfirm(r)}
                onUnhide={() => void unhide(r)}
                onCopyId={() => copyId(r.identity.user_id)}
              />
            ))}
            {shown.length === 0 && (
              <div className="amod-empty">Нет отзывов по выбранному фильтру.</div>
            )}
          </div>
          {rest > 0 && (
            <div className="amod-more">
              <button
                type="button"
                className="amod-btn"
                onClick={() => setMore({ list: listKey, pages: pages + 1 })}
              >
                Показать ещё · осталось {rest}
              </button>
            </div>
          )}
        </>
      )}
    </main>

    {confirm && (
      <AdminConfirmSheet
        label="Скрыть отзыв"
        title="Скрыть отзыв?"
        danger
        busy={busy}
        applyLabel="Скрыть отзыв"
        busyLabel="Скрываю…"
        onCancel={() => !busy && setConfirm(null)}
        onApply={() => void applyHide()}
        text={
          <>
            Отзыв <b>{identityName(confirm.identity)}</b> к квесту «{confirm.quest_name}»
            перестанет показываться на странице квеста и не будет учитываться в средней оценке.
            <span className="amod-preview">
              <span className="amod-preview__label">СРЕДНЯЯ КВЕСТА</span>
              <span className="amod-preview__before">
                {before?.avg == null ? '—' : formatAverage(before.avg)}
              </span>
              <span aria-hidden>→</span>
              <span className="amod-preview__after">
                {after?.avg == null ? 'нет оценок' : formatAverage(after.avg)}
              </span>
            </span>
          </>
        }
      />
    )}
    {bulk && (
      <AdminConfirmSheet
        label="Отметить проверенными"
        title={`Отметить проверенными ${pluralCount(bulk.length, 'отзыв', 'отзыва', 'отзывов')}?`}
        busy={busy}
        applyLabel="Отметить проверенными"
        busyLabel="Отмечаю…"
        onCancel={() => !busy && setBulk(null)}
        onApply={() => void applyBulk()}
        text={
          <>
            Они уйдут из «Новых» и из счётчика в меню у всех администраторов. Если игрок
            потом изменит оценку или текст, отзыв снова станет новым.
          </>
        }
      />
    )}
    {toast && <AdminToast text={toast} />}
    </>
  );
}

/** The picked quest as the site shows it: its average and the spread of visible stars. */
function QuestSummaryCard({ summary }: { summary: QuestSummary }) {
  return (
    <section className="amod-summary" aria-label="Сводка по квесту">
      <div className="amod-summary__avg">
        <span className="amod-summary__label">СРЕДНЯЯ НА САЙТЕ</span>
        <span className="amod-summary__value">
          {summary.avg == null ? '—' : formatAverage(summary.avg)}
        </span>
        <span className="amod-summary__note">
          {summary.count > 0
            ? pluralCount(summary.count, 'оценка', 'оценки', 'оценок')
            : 'видимых оценок нет'}{' '}
          · {summary.hidden} скрыто
        </span>
      </div>
      <div className="amod-summary__bars">
        {[5, 4, 3, 2, 1].map((star) => (
          <div key={star} className="amod-bar">
            <span>{star}★</span>
            <span className="amod-bar__track">
              <span
                className="amod-bar__fill"
                style={{ width: `${summary.count ? (summary.stars[star] / summary.count) * 100 : 0}%` }}
              />
            </span>
            <span className="amod-bar__n">{summary.stars[star]}</span>
          </div>
        ))}
      </div>
    </section>
  );
}

const STATUS_TAGS: Record<Exclude<ReviewStatus, 'checked'>, string> = {
  new: 'НОВЫЙ',
  changed: 'ИЗМЕНЁН',
};

/**
 * The moderation line under a card: who hid it (hiding checks it too), else who
 * checked it — for the review as it is now. The history that went live already
 * checked has nobody to name, so it gets no line.
 */
function markLine(review: AdminReviewWire, status: ReviewStatus): string | null {
  const [label, mark] = review.hide
    ? ['Скрыто', review.hide]
    : status === 'checked' && review.check && review.check.by_id !== 'baseline'
      ? ['Проверено', review.check]
      : [null, null];
  if (!label || !mark) return null;
  return [label, markWho(mark), moderationDate(mark.at)].filter(Boolean).join(' · ');
}

function ReviewCard({
  review,
  status,
  onCheck,
  onHide,
  onUnhide,
  onCopyId,
}: {
  review: AdminReviewWire;
  status: ReviewStatus;
  onCheck: () => void;
  onHide: () => void;
  onUnhide: () => void;
  onCopyId: () => void;
}) {
  const badge = identityBadge(review.identity.kind);
  const where = [review.quest_name, review.quest_city].filter(Boolean).join(' · ');
  const at = new Date(review.created_at * 1000);
  const marks = markLine(review, status);
  return (
    <div
      className={`amod-card${review.hidden ? ' is-hidden' : ''}${status !== 'checked' ? ' is-new' : ''}`}
    >
      <div className="amod-card__body">
        <div className="amod-card__head">
          <span className="amod-card__name">{identityName(review.identity)}</span>
          <span className={`amod-badge amod-badge--${badge.kind}`}>{badge.label}</span>
          {status !== 'checked' && (
            <span className={`amod-chip-tag amod-chip-tag--${status}`}>{STATUS_TAGS[status]}</span>
          )}
          {/* Anonymous devices have no account, so no Пользователи entry. */}
          {review.identity.kind !== 'anon' && (
            <Link
              className="amod-jump"
              href={`/admin?user=${encodeURIComponent(review.identity.user_id)}`}
            >
              ↗ Пользователи
            </Link>
          )}
          <button
            type="button"
            className="amod-jump"
            title={review.identity.user_id}
            onClick={onCopyId}
          >
            Копировать ID
          </button>
        </div>
        <div className="amod-card__rating">
          <span className="amod-stars" aria-label={`${review.rating} из 5`}>
            {[1, 2, 3, 4, 5].map((i) => (
              <span key={i} className={`amod-star${i <= review.rating ? ' is-on' : ''}`}>
                ★
              </span>
            ))}
          </span>
          <span className="amod-card__meta">
            {where} ·{' '}
            <time
              dateTime={at.toISOString()}
              title={at.toLocaleString('ru-RU', { dateStyle: 'long', timeStyle: 'short' })}
            >
              {moderationDate(review.created_at)}
            </time>
          </span>
        </div>
        {review.text ? (
          <p className="amod-card__text">{review.text}</p>
        ) : (
          <p className="amod-card__star-only">Оценка без отзыва — учитывается только в средней.</p>
        )}
        <ContactRow identity={review.identity} />
        {marks && <p className="amod-card__marks">{marks}</p>}
      </div>
      <div className="amod-card__actions">
        {status !== 'checked' && (
          <button type="button" className="amod-btn amod-btn--resolve" onClick={onCheck}>
            Проверено
          </button>
        )}
        {review.hidden ? (
          <>
            <span className="amod-chip-tag">СКРЫТО</span>
            <button type="button" className="amod-btn" onClick={onUnhide}>
              Показать
            </button>
          </>
        ) : (
          <button type="button" className="amod-btn amod-btn--danger" onClick={onHide}>
            Скрыть
          </button>
        )}
      </div>
    </div>
  );
}
