'use client'; // narrow island ONLY for the live catalog + owned set (§2)

import React, { useEffect, useMemo, useState } from 'react';
import SiteShell from './components/SiteShell';
import QuestCard from './components/QuestCard';
import QuestFilters, { matchesAttrs, type QuestFiltersValue } from './components/QuestFilters';
import { api, type PublishedQuestWire } from '../lib/api';
import { currentPlayerId } from '../lib/identity';
import { catalogFacts, factsLine } from '../lib/storefront';

/**
 * Landing v2 (SPEC §2 / Landing v2.dc.html). The store grid is 100% live: every
 * card is a real published quest from GET /api/quests and every field is the
 * author's real data. The hero facts row derives from the same response —
 * nothing on this page is fabricated. Purchase status lives in the cards
 * (QuestCard), never under the grid.
 */

/** §2.4 feature cards: full-phrase headlines, four DISTINCT photo slots.
 *  Real photos are pending — labeled placeholders ship until the assets exist. */
const FEATURES = [
  { label: 'фото: экран квеста в руке', title: 'Все задания — в смартфоне', text: 'Начать и продолжить можно в любое время, число попыток не ограничено.' },
  { label: 'фото: компания на прогулке', title: 'Любое число участников', text: 'Проходите в одиночку или дружной компанией — вместе веселее.' },
  { label: 'фото: деталь старого города', title: 'Игра со смыслом', text: 'Квест знакомит с городскими легендами и историческими персонажами.' },
  { label: 'фото: скрытый двор / место', title: 'Маршруты к необычным местам', text: 'Ведём туда, мимо чего проходят даже местные.' },
];

const EMPTY_FILTERS: QuestFiltersValue = { search: '', complexity: '', age: '', tag: '' };

export default function GeoQuestHome() {
  // `market` is the loaded list, or null on a catalog FAILURE; `marketLoading`
  // keeps the initial render distinct from a failure so loading never flashes
  // the error message.
  const [market, setMarket] = useState<PublishedQuestWire[] | null>(null);
  const [marketLoading, setMarketLoading] = useState(true);
  const [owned, setOwned] = useState<Record<string, boolean>>({});
  // Store filters — the same bar as the constructor dashboard (QuestFilters);
  // no status here because the store lists only published quests.
  const [filters, setFilters] = useState<QuestFiltersValue>(EMPTY_FILTERS);

  const filtered = useMemo(() => {
    if (!market) return [];
    const q0 = filters.search.trim().toLowerCase();
    return market.filter(
      (q) =>
        matchesAttrs(filters, q) &&
        (q0 === '' ||
          q.name.toLowerCase().includes(q0) ||
          (q.city ?? '').toLowerCase().includes(q0)),
    );
  }, [market, filters]);

  // Tag options are the tags that actually exist across the catalog.
  const allTags = useMemo(
    () =>
      market
        ? Array.from(new Set(market.flatMap((q) => q.tags))).sort((a, b) => a.localeCompare(b, 'ru'))
        : [],
    [market],
  );

  // Catalog and grants load INDEPENDENTLY: the catalog is public and
  // identity-free; a grants failure merely leaves the owned-set empty.
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

  const facts = market && market.length > 0 ? factsLine(catalogFacts(market)) : null;

  return (
    <SiteShell>

      {/* HERO — §2.3: headline + CTA stay; the facts row is live catalog data. */}
      <section className="hero" style={{ backgroundImage: "url('/assets/img/hero-main.png')" }} data-screen-label="Главная — хиро">
        <div className="hero__inner container">
          <h1 className="hero__title display">авторские квесты</h1>
          <p className="hero__subtitle">откройте город с новой стороны</p>
          {facts && (
            <p className="hero__facts">
              <span>{facts.quests}</span>
              <span className="hero__facts-dot">·</span>
              <span>{facts.cities}</span>
              {facts.rating && (
                <>
                  <span className="hero__facts-dot">·</span>
                  <span className="hero__facts-rating"><span className="ic" aria-hidden />{facts.rating}</span>
                </>
              )}
            </p>
          )}
          <a className="btn" href="#shop">Выбрать квест</a>
        </div>
      </section>

      {/* §2.4 features: full phrases, four distinct (placeholder) photos */}
      <section className="container" style={{ paddingTop: 90 }} data-screen-label="Главная — коротко о квестах">
        <h2 className="section-title display">коротко о квестах</h2>
        <p style={{ maxWidth: 700, margin: '48px auto 0', textAlign: 'center' }}>
          GEOquest&nbsp;— это игра-экскурсия: участники выполняют задания в&nbsp;городе&nbsp;—
          находят на&nbsp;местности ответ на&nbsp;вопрос или отгадывают логическую загадку.
        </p>
        <div className="features" style={{ marginTop: 48 }}>
          {FEATURES.map((f) => (
            <article className="feature card" key={f.title}>
              <span className="feature__photo-slot" role="img" aria-label={f.label}>
                <span>{f.label}</span>
              </span>
              <div>
                <h3>{f.title}</h3>
                <p>{f.text}</p>
              </div>
            </article>
          ))}
        </div>
      </section>

      {/* §2.1/§2.2 store grid — live quests, purchase status inside the cards */}
      <section className="container container--wide" id="shop" style={{ paddingTop: 90 }} data-screen-label="Главная — магазин квестов">
        <h2 className="section-title display">магазин квестов</h2>
        {marketLoading ? (
          <p className="shop-note">Загружаем магазин…</p>
        ) : market === null ? (
          <p className="shop-note shop-note--error">
            Не удалось загрузить магазин — проверьте подключение и обновите страницу.
          </p>
        ) : market.length === 0 ? (
          <p className="shop-note">Скоро здесь появятся квесты.</p>
        ) : (
          <>
            <div style={{ marginTop: 48 }}>
              <QuestFilters
                value={filters}
                onChange={setFilters}
                tags={allTags}
                searchPlaceholder="Название или город…"
              />
            </div>
            {filtered.length === 0 ? (
              <p className="shop-note">
                Ничего не нашлось.{' '}
                <button type="button" className="shop-note__reset" onClick={() => setFilters(EMPTY_FILTERS)}>
                  Сбросить фильтры
                </button>
              </p>
            ) : (
              <div className="quest-grid" style={{ marginTop: 48 }}>
                {filtered.map((q) => (
                  <QuestCard key={q.quest_id} quest={q} owned={!!owned[q.quest_id]} />
                ))}
              </div>
            )}
          </>
        )}
      </section>

    </SiteShell>
  );
}
