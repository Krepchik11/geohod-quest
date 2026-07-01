'use client'; // narrow island ONLY for buy/checkout (react.md + design). All visual is static design-matched.

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import SiteHeader from './SiteHeader';
import { api, type PublishedQuestWire } from '../lib/api';
import { coverCss } from '../lib/cover';
import { currentPlayerId } from '../lib/identity';

/**
 * Landing — exact design/site/Главная.html (HANDOFF first source + user "design ... first source of page style").
 * Uses .site + .container + hero/quest-card/features/footer exact classes + copy + composite .ic + assets.
 * The store grid is 100% live: every card is a real published quest from GET
 * /api/quests, and every field (city/duration/price/rating) is the author's real
 * data — never a demo card or fabricated value. Buy wires to the grant endpoint.
 * SiteHeader small client island for dropdown (exact js/site.js behavior).
 */
export type PublishedQuest = {
  quest_id: string;
  name: string;
  primary_comic?: string | null;
  template_summary: string;
};

/** Russian plural for оценка (rating). */
function ratingPlural(n: number): string {
  const m = n % 10;
  const h = n % 100;
  if (m === 1 && h !== 11) return 'оценка';
  if (m >= 2 && m <= 4 && (h < 12 || h > 14)) return 'оценки';
  return 'оценок';
}

/** One-decimal rating without a trailing ".0" (5 → "5", 4.5 → "4.5"). */
function fmtRating(avg: number): string {
  return (Math.round(avg * 10) / 10).toString();
}

/** Price chip text: a real number of rubles, "Бесплатно" for 0, or "" when unset. */
function priceLabel(price: number | null): string {
  if (price == null) return '';
  return price === 0 ? 'Бесплатно' : `${price} ₽`;
}

export default function GeoQuestHome() {
  // Live marketplace: ALL published quests from the backend, owned state from
  // grants for the CURRENT identity (anonymous device or account). `market` is the
  // loaded list, or null on a catalog FAILURE; `marketLoading` keeps the initial
  // (not-yet-resolved) render distinct from a failure, so loading never flashes the
  // error message.
  const [market, setMarket] = useState<PublishedQuestWire[] | null>(null);
  const [marketLoading, setMarketLoading] = useState(true);
  const [owned, setOwned] = useState<Record<string, boolean>>({});
  const [status, setStatus] = useState<string>('');

  // Catalog and grants load INDEPENDENTLY. The catalog (GET /api/quests) is public
  // and identity-free; grants are auth-scoped. Coupling them in one Promise.all
  // meant a grants rejection discarded the perfectly available catalog and showed
  // the demo "сервер недоступен" card. Now that card appears ONLY when the catalog
  // itself is unreachable; a grants failure merely leaves the owned-set empty.
  useEffect(() => {
    let cancelled = false;
    api.listQuests()
      .then((quests) => { if (!cancelled) setMarket(quests); })
      .catch(() => { if (!cancelled) setMarket(null); })
      .finally(() => { if (!cancelled) setMarketLoading(false); });
    api.listGrants()
      .then((grants) => {
        if (cancelled) return;
        const playerId = currentPlayerId();
        setOwned(Object.fromEntries(
          grants.filter((g) => g.player_id === playerId).map((g) => [g.quest_id, true])
        ));
      })
      .catch(() => { if (!cancelled) setOwned({}); });
    return () => { cancelled = true; };
  }, []);

  const handleBuy = async (questId: string) => {
    setStatus('Оформляем покупку…');
    try {
      await api.checkout({ player_id: currentPlayerId(), quest_id: questId });
      setOwned((o) => ({ ...o, [questId]: true }));
      setStatus('Квест ваш — навсегда. Найдёте его в «Моих квестах».');
    } catch {
      setStatus('Не удалось завершить покупку. Попробуйте ещё раз чуть позже.');
    }
  };

  return (
    <div className="site">
      <SiteHeader />

      {/* HERO exact from design/site/Главная.html */}
      <section className="hero" style={{ backgroundImage: "url('/assets/img/hero-main.png')" }} data-screen-label="Главная — хиро">
        <div className="hero__inner container">
          <h1 className="hero__title display">авторские квесты</h1>
          <p className="hero__subtitle">откройте город с новой стороны</p>
          <a className="btn" href="#shop">Выбрать квест</a>
        </div>
      </section>

      {/* коротко + features exact (design) */}
      <section className="container" style={{ paddingTop: 90 }} data-screen-label="Главная — коротко о квестах">
        <h2 className="section-title display">коротко о квестах</h2>
        <p style={{ maxWidth: 700, margin: '48px auto 0', textAlign: 'center' }}>
          GEOquest&nbsp;— это игра-экскурсия, в&nbsp;ходе которой участники выполняют задания в&nbsp;городе.
          Например, находят на&nbsp;местности ответ на&nbsp;вопрос или отгадывают логическую загадку.
        </p>
        <div className="features" style={{ marginTop: 48 }}>
          <article className="feature card">
            <img src="/assets/img/feature-smartphone.jpg" alt="Задания в смартфоне" />
            <div>
              <h3>Все задания в смартфоне</h3>
              <p>Начать и продолжить квест можно в&nbsp;любое время. Число попыток неограничено.</p>
            </div>
          </article>
          <article className="feature card">
            <img src="/assets/img/feature-group.jpg" alt="Компания участников" />
            <div>
              <h3>Любое число участников</h3>
              <p>Проходить квест можно одному, но&nbsp;играть дружной компанией веселее!</p>
            </div>
          </article>
          <article className="feature card">
            <img src="/assets/img/feature-group.jpg" alt="Городские легенды" />
            <div>
              <h3>Игра со смыслом:</h3>
              <p>познакомит с городскими легендами и&nbsp;историческими персонажами.</p>
            </div>
          </article>
          <article className="feature card">
            <img src="/assets/img/feature-smartphone.jpg" alt="Необычные места города" />
            <div>
              <h3>Квесты разработаны так,</h3>
              <p>чтобы привлечь внимание к&nbsp;необычным местам города.</p>
            </div>
          </article>
        </div>
      </section>

      {/* магазин + .quest-grid (design card layout) — 100% LIVE published quests.
          No demo card and no fabricated fields: an unreachable catalog shows an
          honest error, an empty catalog an honest "скоро", and each card renders
          ONLY the author's real city/duration/price/rating. */}
      <section className="container" id="shop" style={{ paddingTop: 90 }} data-screen-label="Главная — магазин квестов">
        <h2 className="section-title display">магазин квестов</h2>
        {marketLoading ? (
          <p style={{ textAlign: 'center', marginTop: 48, fontSize: 14, color: '#6b7280' }}>
            Загружаем магазин…
          </p>
        ) : market === null ? (
          <p style={{ textAlign: 'center', marginTop: 48, fontSize: 14, color: '#B45309' }}>
            Не удалось загрузить магазин — проверьте подключение и обновите страницу.
          </p>
        ) : market.length === 0 ? (
          <p style={{ textAlign: 'center', marginTop: 48, fontSize: 14, color: '#6b7280' }}>
            Скоро здесь появятся квесты.
          </p>
        ) : (
          <div className="quest-grid" style={{ marginTop: 48 }}>
            {market.map((q) => {
              const playUrl = `/quest/${encodeURIComponent(q.quest_id)}`;
              const isOwned = !!owned[q.quest_id];
              const free = q.price === 0;
              return (
                <article className="quest-card card" key={q.quest_id}>
                  <a className="quest-card__photo" href={playUrl} style={{ backgroundImage: coverCss(q.primary_comic) }}>
                    <span className="qmark">?</span>
                  </a>
                  <div className="quest-card__body">
                    {(q.city || q.duration) && (
                      <p className="quest-card__meta">
                        {q.city && (
                          <><span><span className="ic" style={{ '--ic': "url('/assets/icons/c/ic-pin--navy.svg')" } as React.CSSProperties} /></span>{q.city}</>
                        )}
                        {q.duration && (
                          <><span><span className="ic" style={{ '--ic': "url('/assets/icons/c/ic-clock-ring--navy.svg')" } as React.CSSProperties} /></span>{q.duration}</>
                        )}
                      </p>
                    )}
                    <h3 className="quest-card__title"><a href={playUrl}>{q.name}</a></h3>
                    {q.rating_count > 0 ? (
                      <p className="rating quest-card__rating">
                        <span className="ic" /><b>{fmtRating(q.rating_avg)}</b>
                        <span className="muted">({q.rating_count}&nbsp;{ratingPlural(q.rating_count)})</span>
                      </p>
                    ) : (
                      <p className="rating quest-card__rating"><span className="muted">Нет оценок</span></p>
                    )}
                    <hr className="quest-card__divider" />
                    <div className="quest-card__footer">
                      <span className="quest-card__price">{isOwned ? 'Куплен' : priceLabel(q.price)}</span>
                      {isOwned ? (
                        <a className="btn" href={playUrl}>Пройти</a>
                      ) : (
                        <button className="btn" onClick={() => handleBuy(q.quest_id)}>{free ? 'Получить' : 'Купить'}</button>
                      )}
                    </div>
                  </div>
                </article>
              );
            })}
          </div>
        )}
        {status && <p style={{ textAlign: 'center', marginTop: 24, fontSize: 13 }}>{status}</p>}
      </section>

      {/* (about text already in features section above per design) */}


      {/* (old Figma admin demo removed; design footer + narrow facts button below) */}

      {/* To-top + exact footer (design) */}
      <button className="to-top" type="button" aria-label="Наверх" onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })}>
        <span className="ic" />
      </button>

      <footer className="site-footer" id="contacts">
        <div className="site-footer__inner">
          <p className="site-footer__tagline">авторские квесты</p>
          <div className="site-footer__grid">
            <a className="contact" href="mailto:geoquest@gmail.com">
              <span className="contact__tile"><span className="ic ic-mail"><span className="b" /><span className="f" /></span></span>
              <span><span className="contact__label">Пишите:</span><span className="contact__value">geoquest@gmail.com</span></span>
            </a>
            <a className="contact" href="tel:+381628888888">
              <span className="contact__tile"><span className="ic ic-phone" /></span>
              <span><span className="contact__label">Звоните:</span><span className="contact__value">+381 (062) 888 88 88 <em style={{ fontStyle: 'normal' }}>(+ мессенджеры)</em></span></span>
            </a>
            <div className="site-footer__links">
              <a href="#">Политика конфиденциальности</a>
              <a href="#">Пользовательское соглашение</a>
              <div className="payments" aria-label="Способы оплаты">
                <span className="pay pay--visa" title="Visa"><span className="g" /></span>
                <span className="pay pay--mc" title="Mastercard"><span className="g" /></span>
                <span className="pay pay--pp" title="PayPal"><span className="g" /></span>
              </div>
            </div>
            <a className="contact" href="https://geohod.ru" target="_blank" rel="noopener">
              <span className="contact__tile"><span className="ic ic-globe"><span className="r" /><span className="s" /></span></span>
              <span><span className="contact__label">Путешествуйте с нами:</span><span className="contact__value">geohod.ru</span></span>
            </a>
            <a className="contact" href="https://t.me/serbia_progulki" target="_blank" rel="noopener">
              <span className="contact__tile"><span className="ic ic-tg" /></span>
              <span><span className="contact__label">Подписывайтесь на канал о Сербии:</span><span className="contact__value">https://t.me/serbia_progulki</span></span>
            </a>
          </div>
          <Link className="logo logo--white site-footer__logo" href="/">
            <span className="ic logo-mark" style={{ '--ic': "url('/assets/icons/c/logo-mark--white.svg')" } as React.CSSProperties} />
            <span className="ic logo-text" style={{ '--ic': "url('/assets/icons/c/logo-text--white.svg')" } as React.CSSProperties} />
          </Link>
        </div>
      </footer>
    </div>
  );
}
