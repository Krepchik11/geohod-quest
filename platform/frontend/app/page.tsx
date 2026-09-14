'use client'; // narrow island ONLY for the live catalog + owned set (§2)

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import SiteShell from './components/SiteShell';
import QuestCard from './components/QuestCard';
import StoreToolbar from './components/StoreToolbar';
import { api, type PublishedQuestWire } from '../lib/api';
import { useOwned } from '../lib/collection';
import { catalogFacts, factsLine, fmtRating } from '../lib/storefront';
import { EMPTY_FACETS, matchesAttrs, type FacetFilters } from '../lib/quest-filters';
import { sortQuests } from '../lib/store-query';
import { useStoreQuery } from '../lib/useStoreQuery';

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

/** Facet option lists are the values the catalog actually has, ru-collated. */
const uniqRu = (values: string[]) =>
  Array.from(new Set(values)).sort((a, b) => a.localeCompare(b, 'ru'));

export default function GeoQuestHome() {
  // `market` is the loaded list, or null on a catalog FAILURE; `marketLoading`
  // keeps the initial render distinct from a failure so loading never flashes
  // the error message.
  const [market, setMarket] = useState<PublishedQuestWire[] | null>(null);
  const [marketLoading, setMarketLoading] = useState(true);
  const { owned } = useOwned();

  // Facet options are the values the catalog actually has; they also tell the
  // URL state which values of the open sets (city, tag) are still real.
  const facetValues = useMemo(
    () =>
      market
        ? {
            cities: uniqRu(market.map((q) => q.city).filter((c): c is string => !!c)),
            tags: uniqRu(market.flatMap((q) => q.tags)),
          }
        : null,
    [market],
  );

  // The applied store state lives in the URL (lib/useStoreQuery); the toolbar
  // hands back a whole new query on apply and keeps only a draft until then.
  const [query, applyQuery] = useStoreQuery(facetValues);

  /** ONE predicate for the grid and for the toolbar's live «Показать N». */
  const matching = useCallback(
    (f: FacetFilters) =>
      market ? market.filter((q) => matchesAttrs(f, q, owned.has(q.quest_id))) : [],
    [market, owned],
  );

  const visible = useMemo(() => sortQuests(matching(query.filters), query.sort), [matching, query]);

  // The catalog is public and identity-free; the owned set comes from the
  // shared identity-keyed collection (lib/collection).
  useEffect(() => {
    let cancelled = false;
    api.listQuests()
      .then((quests) => { if (!cancelled) setMarket(quests); })
      .catch(() => { if (!cancelled) setMarket(null); })
      .finally(() => { if (!cancelled) setMarketLoading(false); });
    return () => { cancelled = true; };
  }, []);

  // The hero shows the aggregate twice over: factsLine for the counted phrases,
  // the raw average for the rating tile's own number + caption.
  const catalog = market && market.length > 0 ? catalogFacts(market) : null;
  const facts = catalog ? factsLine(catalog) : null;

  return (
    <SiteShell>

      {/* HERO — §2.3: headline + CTA stay; the facts row is live catalog data. */}
      <section className="hero" style={{ backgroundImage: "url('/assets/img/hero-main.png')" }} data-screen-label="Главная — хиро">
        <div className="hero__inner container">
          <h1 className="hero__title display">авторские<br />квесты</h1>
          <p className="hero__subtitle">Смотри на город по-новому!</p>
          {facts && (
            <ul className="hero__facts">
              <li className="hero__fact">
                <span className="ic" style={{ '--ic': "url('/assets/icons/c/ic-flag--navy.svg')" } as React.CSSProperties} />
                <span className="hero__fact-value">{facts.quests}</span>
              </li>
              <li className="hero__fact">
                <span className="ic" style={{ '--ic': "url('/assets/icons/c/ic-pin--navy.svg')" } as React.CSSProperties} />
                <span className="hero__fact-value">{facts.cities}</span>
              </li>
              {catalog?.avg != null && (
                <li className="hero__fact">
                  <span className="ic" style={{ '--ic': "url('/assets/icons/c/ic-star-18--gold.svg')" } as React.CSSProperties} />
                  <span>
                    <span className="hero__fact-value">{fmtRating(catalog.avg)}</span>
                    <span className="hero__fact-caption">оценка игроков</span>
                  </span>
                </li>
              )}
            </ul>
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
          /* The toolbar is the FIRST ROW of the card grid (grid-column:1/-1),
             so its left edge meets the first card at any width — a separate
             container drifts from the grid by half a gutter. */
          <div className="quest-grid" style={{ marginTop: 48 }}>
            <StoreToolbar
              query={query}
              onApply={applyQuery}
              cities={facetValues?.cities ?? []}
              tags={facetValues?.tags ?? []}
              /* Offered to a viewer who owns something — and always kept
                 reachable while it is ON, so a link carrying it (or a failed
                 grants load) never leaves an unswitchable filter behind. */
              showOwnedToggle={owned.size > 0 || query.filters.hideOwned}
              countFor={(f) => matching(f).length}
            />
            {visible.length === 0 ? (
              <p className="shop-note shop-note--grid">
                Ничего не нашлось.{' '}
                <button
                  type="button"
                  className="shop-note__reset"
                  onClick={() => applyQuery({ filters: EMPTY_FACETS, sort: query.sort })}
                >
                  Сбросить фильтры
                </button>
              </p>
            ) : (
              visible.map((q) => (
                <QuestCard key={q.quest_id} quest={q} owned={owned.has(q.quest_id)} />
              ))
            )}
          </div>
        )}
      </section>

    </SiteShell>
  );
}
