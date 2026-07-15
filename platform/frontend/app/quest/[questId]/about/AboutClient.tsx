'use client';

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { api, type ProductPageWire } from '../../../../lib/api';
import { currentPlayerId } from '../../../../lib/identity';
import { coverCss, coverSrc as coverSrcForSheet } from '../../../../lib/cover';
import { downloadBundle, type DownloadStage } from '../../../../lib/download';
import { fmtRating, plural, ratingPlural, playersPlural } from '../../../../lib/storefront';
import { pollPaymentSettlement } from '../../../../lib/payment-return';
import PurchaseSheet from '../../../components/PurchaseSheet';
import InstallQuestButton from '../../../components/InstallQuestButton';

/**
 * §3 product page body: model data only (cover, meta, description, author,
 * chips, rating), the order card (right sticky column on desktop / sticky
 * bottom bar on mobile) and the §3.3 confirmation sheet. Post-purchase the
 * card flips to owned IN PLACE and the offline bundle downloads silently
 * (§3.4) with visible progress in the order card (§4.2).
 */

/** §3.1 content chips derived from the published snapshot; unknown chips hide. */
export function productChips(p: Pick<ProductPageWire, 'pages' | 'tasks' | 'paid_hints'>): string[] {
  const chips: string[] = [];
  if (p.pages != null) chips.push(`${p.pages} ${plural(p.pages, 'страница', 'страницы', 'страниц')}`);
  if (p.tasks != null) chips.push(`${p.tasks} ${plural(p.tasks, 'задание', 'задания', 'заданий')}`);
  if (p.paid_hints) chips.push('подсказки за монеты');
  chips.push('работает офлайн');
  return chips;
}

/** «июнь 2026» — month-precision review date. */
export function reviewMonth(unixSecs: number): string {
  return new Date(unixSecs * 1000).toLocaleDateString('ru-RU', { month: 'long', year: 'numeric' }).replace(' г.', '');
}

function Benefits({ p }: { p: ProductPageWire }) {
  const content = [p.pages != null ? `${p.pages} ${plural(p.pages, 'страница', 'страницы', 'страниц')}` : null,
    p.tasks != null ? `${p.tasks} ${plural(p.tasks, 'задание', 'задания', 'заданий')}` : null,
    p.paid_hints ? 'подсказки за монеты' : null].filter(Boolean).join(' · ');
  return (
    <div className="qp-benefits">
      <span><i>✓</i>Доступ навсегда, попытки не ограничены</span>
      {content && <span><i>✓</i>{content}</span>}
      <span><i>✓</i>Скачивается и работает офлайн</span>
    </div>
  );
}

export default function AboutClient({ questId }: { questId: string }) {
  const [product, setProduct] = useState<ProductPageWire | null>(null);
  const [failed, setFailed] = useState<'load' | 'notfound' | null>(null);
  const [owned, setOwned] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [granting, setGranting] = useState(false);
  const [grantError, setGrantError] = useState(false);
  const [dl, setDl] = useState<DownloadStage | null>(null);
  // A ЮKassa return lands here with ?payment={id}; captured once at mount.
  // (Lazy init is hydration-safe: the order card — the only consumer — renders
  // after the client-side product fetch anyway.)
  const [returnPaymentId] = useState(() =>
    typeof window !== 'undefined' ? new URLSearchParams(window.location.search).get('payment') : null,
  );
  // Poll verdict; `pending` = still processing after the finite poll schedule.
  const [payOutcome, setPayOutcome] = useState<null | 'succeeded' | 'canceled' | 'pending'>(null);
  const payResult = returnPaymentId && !payOutcome ? 'checking' : payOutcome;

  useEffect(() => {
    let cancelled = false;
    api.getQuestProduct(questId)
      .then((p) => { if (!cancelled) setProduct(p); })
      .catch((e: unknown) => {
        if (cancelled) return;
        setFailed((e as { status?: number })?.status === 404 ? 'notfound' : 'load');
      });
    api.listGrants()
      .then((grants) => {
        if (cancelled) return;
        const me = currentPlayerId();
        setOwned(grants.some((g) => g.player_id === me && g.quest_id === questId));
      })
      .catch(() => { /* owned stays false; purchase still works */ });
    return () => { cancelled = true; };
  }, [questId]);

  const playUrl = `/quest/${encodeURIComponent(questId)}`;

  // §3.4/§4.2 auto-download with visible progress in the order card.
  const startDownload = () => {
    setDl('fetching');
    downloadBundle(questId, currentPlayerId(), api, (stage) => setDl(stage))
      .catch(() => setDl(null)); // silent here; My Quests offers the visible retry
  };

  const onPurchased = () => {
    setSheetOpen(false);
    setOwned(true);
    startDownload();
  };

  const grantFree = async () => {
    setGranting(true);
    setGrantError(false);
    try {
      await api.checkout({ player_id: currentPlayerId(), quest_id: questId });
      setOwned(true);
      startDownload();
    } catch {
      setGrantError(true);
    } finally {
      setGranting(false);
    }
  };

  // §3.3 results: each poll lets the backend settle against ЮKassa, so the
  // happy path needs no webhook. The param is stripped immediately — a reload
  // must not re-run a finished flow.
  useEffect(() => {
    if (!returnPaymentId) return;
    const params = new URLSearchParams(window.location.search);
    params.delete('payment');
    const query = params.toString();
    window.history.replaceState(null, '', `${window.location.pathname}${query ? `?${query}` : ''}`);
    let cancelled = false;
    void pollPaymentSettlement(returnPaymentId).then((outcome) => {
      if (cancelled) return;
      setPayOutcome(outcome);
      if (outcome === 'succeeded') {
        setOwned(true);
        startDownload();
      }
    });
    return () => { cancelled = true; };
    // startDownload is stable in behavior; this effect runs once per return.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [returnPaymentId]);

  if (failed === 'notfound') {
    return (
      <main className="container qp qp--empty">
        <p>Этого квеста больше нет в магазине.</p>
        <Link className="btn btn--secondary btn--md" href="/#shop">В магазин квестов</Link>
      </main>
    );
  }
  if (failed === 'load') {
    return (
      <main className="container qp qp--empty">
        <p>Не удалось загрузить страницу квеста — проверьте подключение.</p>
      </main>
    );
  }
  if (!product) {
    return <main className="container qp qp--empty"><p>Загружаем…</p></main>;
  }

  const p = product;
  const free = p.price === 0;

  const orderCard = owned ? (
    <div className="qp-order card">
      {payResult === 'succeeded' && <p className="qp-payok">Оплата прошла — квест ваш навсегда.</p>}
      <span className="qp-owned">✓ Квест куплен</span>
      <Link className="btn btn--block" href={playUrl}>Пройти квест</Link>
      {dl && dl !== 'done' && (
        <div className="qp-dl">
          <span className="psheet__spinner qp-dl__spin" aria-hidden />
          <span className="qp-dl__body">
            <span>Скачиваем для офлайна…</span>
            <span className="qp-dl__bar"><span style={{ width: dl === 'fetching' ? '30%' : dl === 'storing' ? '60%' : '85%' }} /></span>
          </span>
        </div>
      )}
      {dl === 'done' && <span className="qp-dl-done">⭳ Квест скачан — играйте офлайн</span>}
      {/* §5: quest-scoped manifest is linked on this page — install prompts for THIS quest */}
      <InstallQuestButton cover={coverSrcForSheet(p.primary_comic)} />
    </div>
  ) : (
    <div className="qp-order card">
      {payResult === 'checking' && (
        <p className="qp-paywait">
          <span className="psheet__spinner qp-dl__spin" aria-hidden />
          Проверяем оплату…
        </p>
      )}
      {payResult === 'canceled' && (
        <p className="quest-card__error">
          Оплата не прошла — деньги не списаны. Попробуйте ещё раз.
        </p>
      )}
      {payResult === 'pending' && (
        <p className="qp-paywait qp-paywait--long">
          Платёж ещё обрабатывается. Обновите страницу через минуту — квест
          откроется, как только банк подтвердит оплату.
        </p>
      )}
      <div className="qp-order__pricerow">
        <span>Квест целиком</span>
        <b>{free ? 'Бесплатно' : `${p.price ?? 0} ₽`}</b>
      </div>
      <Benefits p={p} />
      {granting ? (
        <button className="btn btn--block is-pending psheet__confirm" type="button" disabled>
          <span className="psheet__spinner" aria-hidden />Оформляем…
        </button>
      ) : free ? (
        <button className="btn btn--block" type="button" onClick={() => void grantFree()}>Получить</button>
      ) : (
        <button className="btn btn--block" type="button" onClick={() => setSheetOpen(true)}>
          Купить за {p.price ?? 0} ₽
        </button>
      )}
      {grantError && (
        <p className="quest-card__error">Не получилось оформить покупку — попробуйте ещё раз.</p>
      )}
      <p className="qp-order__caption">
        Дальше — шаг подтверждения. Покупка привяжется к этому устройству;{' '}
        <Link href="/auth">войдите</Link>, чтобы сохранить её в аккаунте.
      </p>
    </div>
  );

  return (
    <main className={`container qp ${owned ? 'qp--owned-mobile' : ''}`}>
      <p className="qp-crumbs">
        <Link href="/#shop">Магазин квестов</Link> <span>/</span> {p.name}
      </p>

      <div className="qp-grid">
        <div className="qp-left">
          <div className="qp-cover" style={{ backgroundImage: coverCss(p.primary_comic) }} />
          <div>
            <p className="qp-meta">
              {p.city && <span><span className="ic" style={{ '--ic': "url('/assets/icons/c/ic-pin--navy.svg')" } as React.CSSProperties} />{p.city}</span>}
              {p.duration && <span><span className="ic" style={{ '--ic': "url('/assets/icons/c/ic-clock-ring--navy.svg')" } as React.CSSProperties} />{p.duration}</span>}
              {p.rating_count > 0 && (
                <span><span className="ic" style={{ '--ic': "url('/assets/icons/c/ic-star-18--gold.svg')" } as React.CSSProperties} />{fmtRating(p.rating_avg)} · {p.rating_count} {ratingPlural(p.rating_count)}</span>
              )}
              {p.players > 0 && <span>{p.players} {playersPlural(p.players)}</span>}
            </p>
            <h1 className="qp-title display">{p.name}</h1>
            {p.description && <p className="qp-desc">{p.description}</p>}
          </div>

          <div className="qp-chips">
            {productChips(p).map((c) => <span key={c}>{c}</span>)}
          </div>

          {p.author_name && (
            <div className="qp-author">
              <span className="qp-author__avatar" aria-hidden>{p.author_name[0]?.toUpperCase()}</span>
              <span className="qp-author__body">
                <span><b>{p.author_name}</b> — автор квеста</span>
                <span>{`${p.author_published_count} ${plural(p.author_published_count, 'квест', 'квеста', 'квестов')} в магазине`}</span>
              </span>
            </div>
          )}

          {/* §3.5/§11 reviews: newest-first list; aggregate line above it */}
          <div className="qp-reviews">
            <div className="qp-reviews__head">
              <h3>Отзывы игроков</h3>
              {p.rating_count > 0 && (
                <span>
                  {p.rating_count} {ratingPlural(p.rating_count)}
                  {p.reviews_total > 0 && ` · ${p.reviews_total} с отзывом`}
                </span>
              )}
            </div>
            {p.rating_count > 0 && (
              <p className="qp-reviews__agg">★ {fmtRating(p.rating_avg)} · {p.rating_count} {ratingPlural(p.rating_count)}</p>
            )}
            {p.reviews.length > 0 ? (
              <div className="qp-reviews__list">
                {p.reviews.map((r, i) => (
                  <div className="qp-review" key={i}>
                    <div className="qp-review__head">
                      <b>{r.author}</b>
                      <span className="qp-review__stars" aria-label={`Оценка ${r.rating} из 5`}>
                        {[1, 2, 3, 4, 5].map((n) => <span key={n} className={n <= r.rating ? '' : 'is-off'}>★</span>)}
                      </span>
                      <span className="qp-review__date">{reviewMonth(r.created_at)}</span>
                    </div>
                    <p>{r.text}</p>
                  </div>
                ))}
              </div>
            ) : (
              p.rating_count === 0 && <p className="qp-reviews__empty">Пока без отзывов — станьте первым</p>
            )}
          </div>
        </div>

        <div className="qp-right">{orderCard}</div>
      </div>

      {/* §3.2 mobile: sticky purchase bar (the tab bar is hidden on this page) */}
      {!owned && (
        <div className="qp-buybar">
          <span className="qp-buybar__price">
            <small>навсегда</small>
            <b>{free ? 'Бесплатно' : `${p.price ?? 0} ₽`}</b>
          </span>
          {granting ? (
            <button className="btn qp-buybar__btn is-pending psheet__confirm" type="button" disabled>
              <span className="psheet__spinner" aria-hidden />Оформляем…
            </button>
          ) : (
            <button
              className="btn qp-buybar__btn"
              type="button"
              onClick={() => (free ? void grantFree() : setSheetOpen(true))}
            >
              {free ? 'Получить' : 'Купить'}
            </button>
          )}
        </div>
      )}

      {sheetOpen && (
        <PurchaseSheet
          quest={{ quest_id: p.quest_id, name: p.name, city: p.city, duration: p.duration, price: p.price, primary_comic: p.primary_comic }}
          onClose={() => setSheetOpen(false)}
          onPurchased={onPurchased}
        />
      )}
    </main>
  );
}
