'use client';

import React, { useState } from 'react';
import Link from 'next/link';
import SiteHeader from '../SiteHeader';
import { api } from '../../lib/api';
import { currentPlayerId } from '../../lib/identity';

/**
 * Quest detail page - EXACT replica of design/site/Квест.html (node 198:490).
 * Gallery + actions (camera, all-photos), 2x2 info tiles with composite .ic-cmp (loc/dur/dif/lng exact CSS layers),
 * buy, desc+author, reviews (summary + 2 reviews + form with interactive stars + submit -> sent state).
 * Buy integrates with api.checkout + grant -> link to player.
 * Uses design classes 100% (quest-page, quest-layout, quest-gallery, info-tile, ic-cmp, review-form, etc).
 * Stub data for "Ирония Судьбы" (design primary example). Golden param for play.
 * Per constraints: small file, explicit, design source of truth for visuals, blueprint logic for play.
 */
const QUEST_ID = 'mystery-fortress-v1';
const PRICE: number = 300; // demo pricing until the commerce phase (0 = free quest)

export default function QuestDetailPage() {
  const [reviewScore, setReviewScore] = useState(0);
  const [reviewText, setReviewText] = useState('');
  const [reviewSent, setReviewSent] = useState(false);
  // Entry card variant (design: paid | free | owned); owned checked against grants.
  const [owned, setOwned] = useState<boolean | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    api.listGrants()
      .then((grants) => {
        if (cancelled) return;
        const list = grants as Array<{ player_id: string; quest_id: string }>;
        const playerId = currentPlayerId();
        setOwned(list.some((g) => g.player_id === playerId && g.quest_id === QUEST_ID));
      })
      .catch(() => { if (!cancelled) setOwned(false); });
    return () => { cancelled = true; };
  }, []);

  const handleReviewSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!reviewText.trim() || reviewScore === 0) return;
    // Stub: design shows "Спасибо! Ваш отзыв отправлен на модерацию."
    setReviewSent(true);
    // In real: POST /reviews or FeedbackReport via facts
  };

  const setScore = (s: number) => {
    setReviewScore(s);
  };

  return (
    <div className="site">
      <SiteHeader />

      <main className="container quest-page" data-screen-label="Страница квеста">
        <div className="quest-layout">
          <h1 className="quest-title" style={{ gridColumn: '1/3' }}>
            Ирония Судьбы: по следам исторических личностей
          </h1>
          <p className="rating quest-rating">
            <span className="ic" />
            <b>5</b>
            <span className="muted">(2 отзыва)</span>
          </p>

          <div>
            <div
              className="quest-gallery"
              style={{ backgroundImage: "url('/assets/img/quest-card.png')" }}
            >
              <span className="qmark">?</span>
              <div className="quest-gallery__actions">
                <button className="gal-camera" type="button" title="Загрузить фото">
                  <span className="ic" />
                </button>
                <button className="gal-all" type="button">
                  <span className="grid4"><span></span><span></span><span></span><span></span></span>
                  Все фото
                </button>
              </div>
            </div>

            <section className="quest-desc">
              <div className="quest-desc__head">
                <h2>Описание</h2>
                <span className="quest-author">
                  <span>автор: Сергей Шестак</span>
                  <img src="/assets/img/avatar-author.jpg" alt="Сергей Шестак" />
                </span>
              </div>
              <p>
                GEOquest — это игра-экскурсия, в&nbsp;ходе которой участники выполняют задания в&nbsp;городе.
                Например, находят на&nbsp;местности ответ на&nbsp;вопрос или отгадывают логическую загадку.
              </p>
            </section>
          </div>

          <div>
            <div className="quest-info">
              <div className="info-tile">
                <span className="info-tile__icon"><span className="ic-cmp ic-loc"><span className="a"></span></span></span>
                <span><b>Локация</b><small>Нови Сад, Сербия</small></span>
              </div>
              <div className="info-tile">
                <span className="info-tile__icon"><span className="ic-cmp ic-dur"><span className="a"></span></span></span>
                <span><b>Длительность</b><small>1.5 часа</small></span>
              </div>
              <div className="info-tile">
                <span className="info-tile__icon"><span className="ic-cmp ic-dif"><span className="a"></span><span className="b"></span></span></span>
                <span><b>Сложность</b><small>Средняя</small></span>
              </div>
              <div className="info-tile">
                <span className="info-tile__icon"><span className="ic-cmp ic-lng"><span className="a"></span><span className="b"></span><span className="c"></span></span></span>
                <span><b>Языки</b><small>РУ, СРБ, ENG</small></span>
              </div>
            </div>

            {/* Точка входа — entry card per design (paid / free / owned) */}
            <div className="s-card entry-card" style={{ marginTop: 16 }}>
              {owned ? (
                <>
                  <p className="entry-owned">
                    <svg width="15" height="15" viewBox="0 0 16 16"><polyline points="2.5,8.5 6.5,12.5 13.5,4" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" /></svg>
                    Квест в вашей коллекции
                  </p>
                  <Link className="s-btn" href={`/quest/${QUEST_ID}`}>Открыть квест</Link>
                  <p style={{ margin: 0, fontSize: 12, color: 'var(--gray)' }}>Куплен 11.06.2026 · доступ бессрочный</p>
                </>
              ) : PRICE === 0 ? (
                <>
                  <p className="entry-price"><span className="lbl">Цена:</span><b className="free">Бесплатно</b></p>
                  <Link className="s-btn" href="/commerce">Получить бесплатно</Link>
                  <p style={{ margin: 0, fontSize: 12, color: 'var(--gray)' }}>Без оплаты — квест сразу в коллекции</p>
                </>
              ) : (
                <>
                  <p className="entry-price"><span className="lbl">Цена:</span><b>{PRICE} ₽</b></p>
                  <Link className="s-btn" href="/commerce">Купить</Link>
                  <p style={{ margin: 0, fontSize: 12, color: 'var(--gray)' }}>Покупка одним платежом · доступ навсегда</p>
                </>
              )}
            </div>
          </div>
        </div>

        <section className="reviews" data-screen-label="Квест — отзывы">
          <h2>Отзывы</h2>
          <div className="reviews-summary card">
            <p className="reviews-summary__row">Рейтинг: <span className="ic" /> 5/5</p>
            <small>2 отзыва</small>
          </div>

          <article className="review">
            <div className="review__head">
              <span className="review__avatar"><span className="user-icon"><span className="head" style={{ '--ic': "url('/assets/icons/c/ic-user-head--navy.svg')" } as React.CSSProperties}></span><span className="body" style={{ '--ic': "url('/assets/icons/c/ic-user-body--navy.svg')" } as React.CSSProperties}></span></span></span>
              <span className="review__who"><b>Анна</b><small>17.09.2022</small></span>
            </div>
            <div className="stars" aria-label="Оценка 5 из 5">
              <span className="ic" /><span className="ic" /><span className="ic" /><span className="ic" /><span className="ic" />
            </div>
            <p>Отличный квест. Весело провели время, узнали много нового о городе.</p>
          </article>

          <article className="review">
            <div className="review__head">
              <span className="review__avatar"><span className="user-icon"><span className="head" style={{ '--ic': "url('/assets/icons/c/ic-user-head--navy.svg')" } as React.CSSProperties}></span><span className="body" style={{ '--ic': "url('/assets/icons/c/ic-user-body--navy.svg')" } as React.CSSProperties}></span></span></span>
              <span className="review__who"><b>Глеб</b><small>17.10.2022</small></span>
            </div>
            <div className="stars" aria-label="Оценка 5 из 5">
              <span className="ic" /><span className="ic" /><span className="ic" /><span className="ic" /><span className="ic" />
            </div>
            <p>Квест тщательно продуман и прекрасно реализован.</p>
          </article>

          <form className={`review-form card ${reviewSent ? 'is-sent' : ''}`} onSubmit={handleReviewSubmit}>
            <h2>Оставить отзыв</h2>
            <p className="review-form__hint">Ваш адрес email не будет опубликован.</p>
            <div className="review-form__score">
              Оценка:
              <span className="stars" role="radiogroup" aria-label="Ваша оценка">
                {[1,2,3,4,5].map((v) => (
                  <span
                    key={v}
                    className={`ic ${v > reviewScore ? 'is-off' : ''}`}
                    onClick={() => setScore(v)}
                    style={{ cursor: 'pointer' }}
                  />
                ))}
              </span>
            </div>
            <textarea
              placeholder="Комментарии"
              required
              value={reviewText}
              onChange={(e) => setReviewText(e.target.value)}
            />
            <button className="btn" type="submit">Оставить отзыв</button>
            <p className="review-form__ok">Спасибо! Ваш отзыв отправлен на модерацию.</p>
          </form>
        </section>
      </main>

      <Link href="/quest/mystery-fortress-v1" className="btn" style={{ display: 'block', width: 224, margin: '40px auto', textAlign: 'center' }}>
        Начать квест (Play)
      </Link>

      {/* footer via SiteHeader or slot if needed; for now simple */}
    </div>
  );
}
