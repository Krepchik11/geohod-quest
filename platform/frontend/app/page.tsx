'use client'; // narrow island ONLY for buy/checkout + admin demo (react.md + design). All visual is static design-matched.

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import SiteHeader from './SiteHeader';
import { api, type PublishedQuestWire } from '../lib/api';
import { currentPlayerId } from '../lib/identity';

/**
 * Landing — exact design/site/Главная.html (HANDOFF first source + user "design ... first source of page style").
 * Uses .site + .container + hero/quest-card/features/footer exact classes + copy + composite .ic + assets.
 * 1 dynamic card from golden for TDD fidelity; others per design. Buy wires to existing grant (env later).
 * SiteHeader small client island for dropdown (exact js/site.js behavior).
 */
export type PublishedQuest = {
  quest_id: string;
  name: string;
  primary_comic?: string | null;
  template_summary: string;
};

// Admin visibility types (small inline co-located per YAGNI/no-new-files; explicit/derived; reuse goldens note for snap key; casts for TS json)
type AdminStats = {
  grants_count: number;
  attempts_count: number;
  completions_count: number;
  completion_rate: number;
  per_step: Record<string, { wrongs?: number; hints?: number; nav?: number; feedbacks?: number }>;
  hints_used: number;
  wrongs_submitted: number;
  navigator_clicks: number;
  feedback_count: number;
};

/** Design demo card — rendered ONLY when the backend is unreachable (labeled). */
const DEMO_MARKET_CARD: PublishedQuestWire = {
  quest_id: 'mystery-fortress-v1',
  name: 'Ирония Судьбы: по следам исторических личностей',
  primary_comic: null,
  template_summary: 'демо',
  snapshot_version: 1,
  snapshot_id: 'golden-mystery-fortress-v1',
};

export default function GeoQuestHome() {
  // Live marketplace: ALL published quests from the backend, owned state from
  // grants for the CURRENT identity (anonymous device or account). The static
  // design cards below remain only as a labeled fallback when unreachable.
  const [market, setMarket] = useState<PublishedQuestWire[] | null>(null);
  const [owned, setOwned] = useState<Record<string, boolean>>({});
  const [status, setStatus] = useState<string>('');
  const [adminStats, setAdminStats] = useState<AdminStats | null>(null);
  const [adminFbs, setAdminFbs] = useState<unknown[]>([]);
  const [adminStatus, setAdminStatus] = useState<string>('');

  useEffect(() => {
    let cancelled = false;
    Promise.all([api.listQuests(), api.listGrants()])
      .then(([quests, grants]) => {
        if (cancelled) return;
        const playerId = currentPlayerId();
        setMarket(quests);
        setOwned(Object.fromEntries(
          grants.filter((g) => g.player_id === playerId).map((g) => [g.quest_id, true])
        ));
      })
      .catch(() => { if (!cancelled) setMarket(null); });
    return () => { cancelled = true; };
  }, []);

  const handleBuy = async (questId: string) => {
    setStatus('Покупаем (тестовый платёжный провайдер)…');
    try {
      const data = await api.checkout({ player_id: currentPlayerId(), quest_id: questId }) as
        { created?: boolean; grant?: { source?: string } };
      setOwned((o) => ({ ...o, [questId]: true }));
      setStatus(`Квест ваш — навсегда (${data.created ? 'новая покупка' : 'уже куплен'}, source=${data.grant?.source || 'n/a'})`);
    } catch (e) {
      setStatus('Не удалось купить (бэкенд доступен? NEXT_PUBLIC_API_URL): ' + (e as Error).message);
    }
  };

  const loadAdmin = async () => {
    setAdminStatus('Loading (pure facts)...');
    try {
      const base = (typeof process !== 'undefined' && process.env.NEXT_PUBLIC_API_URL) || 'http://localhost:8080';
      const [sres, fres] = await Promise.all([
        fetch(`${base}/api/admin/versions/golden-mystery-fortress-v1/stats`),
        fetch(`${base}/api/admin/versions/golden-mystery-fortress-v1/feedbacks`),
      ]);
      if (!sres.ok || !fres.ok) throw new Error(`HTTP ${sres.status}/${fres.status}`);
      const stats = (await sres.json()) as AdminStats;
      const fbs = (await fres.json()) as unknown[];
      setAdminStats(stats);
      setAdminFbs(fbs);
      setAdminStatus('Loaded from facts');
    } catch (e) {
      setAdminStatus('Admin demo needs backend+play: ' + (e as Error).message);
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

      {/* Big visible callout to the *actually implemented* designed player (paper "Бумага" + full 7 templates + overlays + real backend sync) */}
      <div style={{ background: '#FBF1E5', padding: '20px 0', textAlign: 'center', borderTop: '1px solid #d9d0c3', borderBottom: '1px solid #d9d0c3' }}>
        <a href="/quest" style={{ fontSize: 15, fontWeight: 600, color: '#3E2C2C', textDecoration: 'underline' }}>
          → Открыть реализованный дизайн-плеер (бумажный фрейм, 7 шаблонов, меню, подсказки после 2-й ошибки, синхронизация с бэкендом) — «Ирония судьбы»
        </a>
        <div style={{ fontSize: 11, opacity: 0.65, marginTop: 4 }}>
          Для твоего запуска: <code>NEXT_PUBLIC_API_URL=http://localhost:8087 PORT=8089 npm run dev:frontend</code> (backend на 8087)
        </div>
      </div>

      {/* магазин + .quest-grid (design card layout) — LIVE published quests with
          per-quest buy (mock payment) and owned state; static demo card only as
          a labeled fallback when the backend is unreachable */}
      <section className="container" id="shop" style={{ paddingTop: 90 }} data-screen-label="Главная — магазин квестов">
        <h2 className="section-title display">магазин квестов</h2>
        {market === null && (
          <p style={{ textAlign: 'center', marginTop: 24, fontSize: 13, color: '#B45309' }}>
            демо-карточка — сервер недоступен, живой магазин появится после подключения
          </p>
        )}
        <div className="quest-grid" style={{ marginTop: 48 }}>
          {(market ?? [DEMO_MARKET_CARD]).map((q) => {
            const playUrl = `/quest?golden=${encodeURIComponent(q.quest_id)}`;
            const isOwned = !!owned[q.quest_id];
            return (
              <article className="quest-card card" key={q.quest_id}>
                <a className="quest-card__photo" href={playUrl} style={{ backgroundImage: "url('/assets/img/quest-card.png')" }}>
                  <span className="qmark">?</span>
                  <img className="author" src="/assets/img/avatar-author.jpg" alt="Автор квеста" />
                </a>
                <div className="quest-card__body">
                  <p className="quest-card__meta">
                    <span><span className="ic" style={{ '--ic': "url('/assets/icons/c/ic-pin--navy.svg')" } as React.CSSProperties} /></span>Нови Сад, Сербия
                    <span><span className="ic" style={{ '--ic': "url('/assets/icons/c/ic-clock-ring--navy.svg')" } as React.CSSProperties} /></span>1.5 часа
                  </p>
                  <h3 className="quest-card__title"><a href={playUrl}>{q.name}</a></h3>
                  <p className="rating quest-card__rating"><span className="ic" /><b>5</b><span className="muted">(2 отзыва)</span></p>
                  <hr className="quest-card__divider" />
                  <div className="quest-card__footer">
                    <span className="quest-card__price">{isOwned ? 'Куплен' : '300 ₽'}</span>
                    {isOwned ? (
                      <a className="btn" href={playUrl}>Пройти</a>
                    ) : (
                      <button className="btn" onClick={() => handleBuy(q.quest_id)}>Купить</button>
                    )}
                  </div>
                </div>
              </article>
            );
          })}
        </div>
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
              <a href="#">Разработано maxidev.io</a>
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

      {/* Admin demo narrow */}
      <div style={{ maxWidth: 1240, margin: '40px auto', padding: '0 42px' }}>
        <button onClick={loadAdmin} className="btn-ui" style={{ minWidth: 180 }}>Load admin demo (facts)</button>
        {adminStatus && <div style={{ marginTop: 8, fontSize: 12, color: '#666' }}>{adminStatus}</div>}
        {adminStats && <div style={{ marginTop: 12, fontSize: 12 }}>Grants: {adminStats.grants_count} • Attempts: {adminStats.attempts_count} • Rate: {adminStats.completion_rate}%</div>}
        {status && <div style={{ marginTop: 8, fontSize: 12 }}>{status}</div>}
      </div>
    </div>
  );
}
