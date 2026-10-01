'use client';

import React, { useEffect, useState, useSyncExternalStore } from 'react';
import Link from 'next/link';
import { api, classify, type ProductPageWire, type ReviewWire } from '../../../../lib/api';
import { authHref, BUY_PARAM, buyAgainPath } from '../../../../lib/auth-return';
import { markOwned, useOwns } from '../../../../lib/collection';
import { getSession, subscribeSession, currentUserId } from '../../../../lib/identity';
import { coverCss, coverSrc as coverSrcForSheet } from '../../../../lib/cover';
import { COMPLEXITY_LABEL, type CtorComplexity } from '../../../../lib/constructor-model';
import { downloadBundle, type DownloadStage } from '../../../../lib/download';
import {
  fmtRating,
  inviteText,
  playerCountPlural,
  questPlural,
  questFacts,
  questsInCity,
  ratingPlural,
  reviewPlural,
  showPlayers,
  SUBSTANTIVE_REVIEW_CHARS,
  taskPlural,
} from '../../../../lib/storefront';
import { pollPaymentSettlement } from '../../../../lib/payment-return';
import { mapsSearchUrl } from '../../../../lib/maps';
import PurchaseSheet from '../../../components/PurchaseSheet';
import InstallQuestButton from '../../../components/InstallQuestButton';
import ShareQuestButton from '../../../components/ShareQuestButton';
import { useClientFeature } from '../../../../lib/client-features';

/**
 * §3 product page body: model data only, the order card (right sticky column on
 * desktop / sticky bottom bar on mobile) and the §3.3 confirmation sheet.
 * Post-purchase the card flips to owned IN PLACE and the offline bundle
 * downloads silently (§3.4) with visible progress in the order card (§4.2).
 *
 * Practical first, story second (ТЗ «Дизайн и юзабилити», этап 3): under the
 * title sits «Коротко» — start, time, distance, tasks, company, offline — and
 * only then the description, folded to four lines. Reviews show the three most
 * useful (the backend orders substantive ones first) with the rest one tap away.
 */

/** Reviews shown before «Все N отзывов» (ТЗ, задача 24). */
const REVIEWS_FOLDED = 3;

/** «июнь 2026» — month-precision review date. */
export function reviewMonth(unixSecs: number): string {
  return new Date(unixSecs * 1000).toLocaleDateString('ru-RU', { month: 'long', year: 'numeric' }).replace(' г.', '');
}

/** The review worth quoting next to the price: the first one, when it says
 *  something (the backend serves substantive reviews first). */
export function bestQuote(reviews: ReviewWire[]): ReviewWire | null {
  const first = reviews[0];
  return first && first.text.trim().length >= SUBSTANTIVE_REVIEW_CHARS ? first : null;
}

function Benefits({ p }: { p: ProductPageWire }) {
  const content = [
    p.tasks != null ? `${p.tasks} ${taskPlural(p.tasks)}` : null,
    p.paid_hints ? 'подсказки за монеты' : null,
  ]
    .filter(Boolean)
    .join(' · ');
  return (
    <div className="qp-benefits">
      <span><i>✓</i>Доступ навсегда, попытки не ограничены</span>
      {content && <span><i>✓</i>{content}</span>}
      <span><i>✓</i>Скачивается и работает офлайн</span>
    </div>
  );
}

/** One «Коротко» line: an icon, the fact, a hint under it. */
function Brief({ icon, title, hint }: { icon: string; title: React.ReactNode; hint: React.ReactNode }) {
  return (
    <div className="qp-brief__item">
      <span className={`ic ${icon}`} aria-hidden />
      <span>
        <b>{title}</b>
        <small>{hint}</small>
      </span>
    </div>
  );
}

function Quote({ review, className }: { review: ReviewWire; className: string }) {
  return (
    <figure className={`qp-quote ${className}`}>
      <blockquote>«{review.text.trim()}»</blockquote>
      <figcaption>— {review.author}</figcaption>
    </figure>
  );
}

export default function AboutClient({ questId }: { questId: string }) {
  const [product, setProduct] = useState<ProductPageWire | null>(null);
  const [failed, setFailed] = useState<'load' | 'notfound' | null>(null);
  const owned = useOwns(questId);
  const session = useSyncExternalStore(subscribeSession, getSession, () => null);
  const shareOn = useClientFeature('quest_share');
  const factsOn = useClientFeature('quest_facts');
  const [sheetOpen, setSheetOpen] = useState(false);
  const [granting, setGranting] = useState(false);
  const [grantError, setGrantError] = useState(false);
  const [dl, setDl] = useState<DownloadStage | null>(null);
  // The quest became the player's on THIS page — the moment to invite friends.
  const [justGot, setJustGot] = useState(false);
  const [descOpen, setDescOpen] = useState(false);
  const [reviewsOpen, setReviewsOpen] = useState(false);
  // §11 pagination: pages loaded past the product page's first ten reviews.
  const [moreReviews, setMoreReviews] = useState<ReviewWire[]>([]);
  const [loadingMore, setLoadingMore] = useState(false);
  // A ЮKassa return lands here with ?payment={id}; a sign-in started from the
  // purchase sheet with ?buy=1. Both are read once at mount (lazy init is
  // hydration-safe: their consumers render after the client-side fetch anyway).
  const [returnPaymentId] = useState(() =>
    typeof window !== 'undefined' ? new URLSearchParams(window.location.search).get('payment') : null,
  );
  const [buyAgain, setBuyAgain] = useState(() =>
    typeof window !== 'undefined' && new URLSearchParams(window.location.search).get(BUY_PARAM) === '1',
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
        setFailed(classify(e).kind === 'not-found' ? 'notfound' : 'load');
      });
    return () => { cancelled = true; };
  }, [questId]);

  // Back from signing in mid-purchase (ТЗ, задача 5): the flag is spent at once
  // so a reload never reopens the sheet.
  useEffect(() => {
    if (!buyAgain) return;
    const params = new URLSearchParams(window.location.search);
    params.delete(BUY_PARAM);
    const query = params.toString();
    window.history.replaceState(null, '', `${window.location.pathname}${query ? `?${query}` : ''}`);
  }, [buyAgain]);
  const reopenSheet = buyAgain && !!product && !owned && (product.price ?? 0) > 0;

  const playUrl = `/quest/${encodeURIComponent(questId)}`;

  // §3.4/§4.2 auto-download with visible progress in the order card.
  const startDownload = () => {
    setDl('fetching');
    downloadBundle(questId, currentUserId(), api, (stage) => setDl(stage))
      .catch(() => setDl(null)); // silent here; My Quests offers the visible retry
  };

  const acquired = () => {
    markOwned(questId);
    setJustGot(true);
    startDownload();
  };

  const onPurchased = () => {
    setSheetOpen(false);
    setBuyAgain(false);
    acquired();
  };

  const grantFree = async () => {
    setGranting(true);
    setGrantError(false);
    try {
      await api.checkout({ user_id: currentUserId(), quest_id: questId });
      acquired();
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
      if (outcome === 'succeeded') acquired();
    });
    return () => { cancelled = true; };
    // acquired is stable in behavior; this effect runs once per return.
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
  const facts = questFacts(p, factsOn);
  const allReviews = p.reviews.concat(moreReviews);
  const shownReviews = reviewsOpen ? allReviews : allReviews.slice(0, REVIEWS_FOLDED);
  const quote = bestQuote(p.reviews);
  const complexity = p.complexity && COMPLEXITY_LABEL[p.complexity as CtorComplexity];
  const signInHref = authHref(free ? `/quest/${encodeURIComponent(questId)}/about` : buyAgainPath(questId));
  const loadMoreReviews = () => {
    setLoadingMore(true);
    api
      .getQuestReviews(questId, allReviews.length)
      .then((page) => setMoreReviews((cur) => cur.concat(page.reviews)))
      .catch(() => {})
      .finally(() => setLoadingMore(false));
  };
  const invite = {
    questId,
    name: p.name,
    city: p.city,
    text: inviteText(p.name, p.city, facts.time, free),
  };

  const orderCard = owned ? (
    <div className="qp-order card">
      {payResult === 'succeeded' && <p className="qp-payok">Оплата прошла — квест ваш навсегда.</p>}
      <span className="qp-owned">✓ Квест ваш</span>
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
      {justGot && (
        /* ТЗ, задача 28: the moment the quest is theirs is the moment to bring
           the company — one quest serves all of them. */
        <div className="qp-invite">
          <p>Позовите друзей: один квест — на всю компанию.</p>
          <ShareQuestButton quest={invite} className="btn--block" label="Позвать друзей" />
        </div>
      )}
      {/* §5: quest-scoped manifest is linked on this page — install prompts for THIS quest */}
      <InstallQuestButton cover={coverSrcForSheet(p.primary_comic)} />
      {shareOn && !justGot && <ShareQuestButton quest={{ questId, name: p.name, city: p.city }} className="btn--block" />}
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
      {quote && <Quote review={quote} className="qp-quote--desktop" />}
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
      {!free && <p className="qp-order__caption">Оплата картой российского банка.</p>}
      {!session && (
        <p className="qp-order__caption">
          {free
            ? 'Квест привяжется к этому устройству; '
            : 'Дальше — шаг подтверждения. Покупка привяжется к этому устройству; '}
          <Link href={signInHref}>войдите</Link>, чтобы сохранить {free ? 'его' : 'её'} в аккаунте.
        </p>
      )}
      {/* §share: anyone may pass the quest on, bought or not — the link opens
          this same page, where the recipient buys it themselves. */}
      {shareOn && <ShareQuestButton quest={{ questId, name: p.name, city: p.city }} className="btn--block" />}
    </div>
  );

  return (
    <main className={`container qp ${owned ? 'qp--owned-mobile' : ''}`}>
      <p className="qp-crumbs">
        <Link href="/#shop">{questsInCity(p.city)}</Link> <span>/</span> {p.name}
      </p>

      <div className="qp-grid">
        <div className="qp-left">
          <div className="qp-cover" style={{ backgroundImage: coverCss(p.primary_comic) }} />
          <div>
            <h1 className="qp-title heading">{p.name}</h1>
            {p.rating_count > 0 && (
              <p className="qp-rating">
                <span className="ic ic-star" aria-hidden />
                <b>{fmtRating(p.rating_avg)}</b> · {p.rating_count}&nbsp;{ratingPlural(p.rating_count)}
                {showPlayers(p.players, p.rating_count) && ` · ${p.players} ${playerCountPlural(p.players)}`}
                {' · '}<a href="#reviews">отзывы</a>
              </p>
            )}
          </div>

          {/* ТЗ, задачи 19–22: what a player needs before going out, above the story. */}
          <section className="qp-brief card" aria-labelledby="qp-brief-title">
            <h2 className="qp-brief__title" id="qp-brief-title">Коротко</h2>
            <div className="qp-brief__grid">
              {p.start_point && (
                <Brief
                  icon="ic-pin"
                  title={p.city ? `Старт: ${p.city}` : 'Старт'}
                  hint={
                    <a href={mapsSearchUrl(p.start_point.lat, p.start_point.lng)} target="_blank" rel="noopener noreferrer">
                      Место старта на карте
                    </a>
                  }
                />
              )}
              {facts.time && <Brief icon="ic-clock" title={facts.time} hint="в своём темпе" />}
              {facts.distance && <Brief icon="ic-route" title={facts.distance} hint="пешком" />}
              {(!!p.tasks || complexity) && (
                <Brief
                  icon="ic-tasks"
                  title={p.tasks ? `${p.tasks} ${taskPlural(p.tasks)}` : 'Задания'}
                  hint={complexity ? `${complexity.toLowerCase()} сложность` : 'загадки на маршруте'}
                />
              )}
              <Brief icon="ic-people" title="Компанией" hint="один телефон на всех" />
              <Brief icon="ic-offline" title="Без интернета" hint="скачайте заранее" />
            </div>
            {p.paid_hints && (
              <p className="qp-brief__note">
                Подсказки и пропуск задания — за монеты. <Link href="/rules#coins">Что это?</Link>
              </p>
            )}
          </section>

          {quote && <Quote review={quote} className="qp-quote--mobile" />}

          {p.description && (
            <div className={`qp-desc${descOpen ? ' is-open' : ''}`}>
              <p>{p.description}</p>
              {!descOpen && (
                <button className="qp-desc__more" type="button" onClick={() => setDescOpen(true)}>
                  Читать полностью
                </button>
              )}
            </div>
          )}

          {p.author_name && (
            <div className="qp-author">
              <span className="qp-author__avatar" aria-hidden>{p.author_name[0]?.toUpperCase()}</span>
              <span className="qp-author__body">
                <span><b>{p.author_name}</b> — автор квеста</span>
                <span>{`${p.author_published_count} ${questPlural(p.author_published_count)} в магазине`}</span>
              </span>
            </div>
          )}

          {/* §11 reviews: substantive first (the backend's order), three of
              them until «Все N отзывов» opens the rest. */}
          <div className="qp-reviews" id="reviews">
            <div className="qp-reviews__head">
              <h3>Отзывы игроков</h3>
              {p.rating_count > 0 && (
                <span>
                  {p.rating_count} {ratingPlural(p.rating_count)}
                  {p.reviews_total > 0 && ` · ${p.reviews_total} с отзывом`}
                </span>
              )}
            </div>
            {shownReviews.length > 0 ? (
              <div className="qp-reviews__list">
                {shownReviews.map((r) => (
                  <div className="qp-review" key={`${r.author}-${r.created_at}-${r.text}`}>
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
                {!reviewsOpen && p.reviews_total > REVIEWS_FOLDED ? (
                  <button className="btn btn--secondary" type="button" onClick={() => setReviewsOpen(true)}>
                    Все {p.reviews_total} {reviewPlural(p.reviews_total)}
                  </button>
                ) : (
                  reviewsOpen && allReviews.length < p.reviews_total && (
                    <button className="btn btn--secondary" type="button" disabled={loadingMore} onClick={loadMoreReviews}>
                      Показать ещё
                    </button>
                  )
                )}
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
            <b>{free ? 'Бесплатно' : `${p.price ?? 0} ₽`}</b>
            <small>{free ? 'доступ навсегда' : 'навсегда · карты РФ'}</small>
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

      {(sheetOpen || reopenSheet) && (
        <PurchaseSheet
          quest={{
            quest_id: p.quest_id,
            name: p.name,
            city: p.city,
            duration: p.duration,
            duration_min: p.duration_min,
            distance_km: p.distance_km,
            price: p.price,
            primary_comic: p.primary_comic,
          }}
          onClose={() => {
            setSheetOpen(false);
            setBuyAgain(false);
          }}
          onPurchased={onPurchased}
        />
      )}
    </main>
  );
}
