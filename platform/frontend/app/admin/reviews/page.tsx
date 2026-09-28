'use client';

import React, { useEffect, useState } from 'react';
import { api, type AdminReviewWire } from '../../../lib/api';
import {
  DEFAULT_REVIEWS_QUERY,
  REVIEW_SORTS,
  REVIEW_VIEWS,
  formatAverage,
  identityBadge,
  identityName,
  moderationDate,
  parseReviewsQuery,
  questAverage,
  reviewFacets,
  reviewQuestOptions,
  serializeReviewsQuery,
  type ReviewSort,
  type ReviewsQuery,
} from '../../../lib/admin-moderation';
import { plural } from '../../../lib/ru';
import { AdminConfirmSheet, AdminPageHead, AdminToast, useToast } from '../ui';
import { ContactRow } from '../moderation-ui';

/**
 * Admin · Отзывы (content-moderation). Every quest rating — star-only included —
 * as one row per (player, quest), with a per-(player, quest) hide that drops the
 * rating from the quest page and its average. The hide confirm previews the quest
 * average before→after with the SAME per-player, hide-aware fold the server uses,
 * so the preview can never disagree with what ships.
 *
 * Filters and sort live in the URL (replaceState — a filter click is not a
 * history step), so a reload or a shared link opens the same list.
 */

const RATING_CHIPS: ReadonlyArray<{ value: number; label: string }> = [
  { value: 0, label: 'Все' },
  { value: 5, label: '5★' },
  { value: 4, label: '4★' },
  { value: 3, label: '3★' },
  { value: 2, label: '2★' },
  { value: 1, label: '1★' },
];

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
  const [busy, setBusy] = useState(false);
  const { toast, showToast } = useToast();

  useEffect(() => {
    let cancelled = false;
    void api
      .adminListReviews()
      .then((r) => {
        if (!cancelled) setReviews(r.reviews);
      })
      .catch(() => {
        if (!cancelled) setLoadError(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const setHidden = (target: AdminReviewWire, hidden: boolean) =>
    setReviews((rs) =>
      (rs ?? []).map((r) => (reviewKey(r) === reviewKey(target) ? { ...r, hidden } : r)),
    );

  const applyHide = async () => {
    if (!confirm) return;
    setBusy(true);
    try {
      await api.adminHideReview({
        user_id: confirm.identity.user_id,
        quest_id: confirm.quest_id,
      });
      setHidden(confirm, true);
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
      setHidden(r, false);
      showToast('Отзыв снова виден');
    } catch {
      showToast('Не удалось показать отзыв');
    }
  };

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

  const facets = reviewFacets(reviews ?? [], q);
  const questOptions = reviewQuestOptions(reviews ?? [], facets.quests);
  const shown = facets.list;

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

          <div className="amod-count">
            {shown.length} {plural(shown.length, 'запись', 'записи', 'записей')}
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
            {shown.map((r) => (
              <ReviewCard
                key={reviewKey(r)}
                review={r}
                onHide={() => setConfirm(r)}
                onUnhide={() => void unhide(r)}
                onJump={() =>
                  showToast(`${r.identity.user_id} — в разделе «Пользователи» (вне прототипа)`)
                }
              />
            ))}
            {shown.length === 0 && (
              <div className="amod-empty">Нет отзывов по выбранному фильтру.</div>
            )}
          </div>
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
    {toast && <AdminToast text={toast} />}
    </>
  );
}

function ReviewCard({
  review,
  onHide,
  onUnhide,
  onJump,
}: {
  review: AdminReviewWire;
  onHide: () => void;
  onUnhide: () => void;
  onJump: () => void;
}) {
  const badge = identityBadge(review.identity.kind);
  const where = [review.quest_name, review.quest_city].filter(Boolean).join(' · ');
  const at = new Date(review.created_at * 1000);
  return (
    <div className={`amod-card${review.hidden ? ' is-hidden' : ''}`}>
      <div className="amod-card__body">
        <div className="amod-card__head">
          <span className="amod-card__name">{identityName(review.identity)}</span>
          <span className={`amod-badge amod-badge--${badge.kind}`}>{badge.label}</span>
          <span className="amod-card__pid">{review.identity.user_id}</span>
          <button type="button" className="amod-jump" onClick={onJump}>
            ↗ Пользователи
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
      </div>
      <div className="amod-card__actions">
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
