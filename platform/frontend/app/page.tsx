'use client'; // narrow island ONLY for the live catalog + owned set (§2)

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import SiteShell from './components/SiteShell';
import QuestCard from './components/QuestCard';
import StoreToolbar from './components/StoreToolbar';
import { CityChips, PlayerQuote, SoonBlock, TogetherBlock } from './components/StoreBlocks';
import { api, type PublishedQuestWire } from '../lib/api';
import { useClientFeature, useRememberedClientFeature, useSoonCities } from '../lib/client-features';
import { useOwned } from '../lib/collection';
import { currentUserId } from '../lib/identity';
import { loadOfflineShelf, rememberCatalog, rememberGrants, type OfflineShelf } from '../lib/offline-shelf';
import { latestInProgress, orderOwned, ownedStatus, type InProgress, type OwnedStatus } from '../lib/owned-quests';
import { EMPTY_FACETS, countActiveValues, matchesAttrs, type FacetFilters } from '../lib/quest-filters';
import { saveCity, useSavedCity } from '../lib/saved-city';
import { sortQuests, type StoreQuery } from '../lib/store-query';
import {
  busiestCity,
  catalogFacts,
  cityFacts,
  fmtRating,
  heroTitle,
  playerCountPlural,
  questPlural,
  questsInCity,
  ratingPlural,
  showPlayers,
} from '../lib/storefront';
import { useStoreQuery } from '../lib/useStoreQuery';
import { useStuck } from '../lib/use-stuck';

/** Height of the pinned site header on a phone (globals.css .site-header): the
 *  shop head pins right under it. */
const HEADER_PIN_PX = 64;
/** Height of the pinned shop head on a phone (styles/storefront.css). */
const SHOP_HEAD_PX = 52;

/**
 * Landing v2 (SPEC §2 / Landing v2.dc.html). The store grid is 100% live: every
 * card is a real published quest from GET /api/quests and every field is the
 * author's real data — nothing on this page is fabricated. Purchase status
 * lives in the cards (QuestCard), never under the grid.
 *
 * store_my_quests: the shop is also the player's own shelf. Own quests lead the
 * grid (в процессе → не начатые → пройденные) with their state, progress and
 * offline controls; filters apply to them like to any card, the sort orders
 * only the rest. The hero offers «Продолжить» into the quest in progress. With
 * no network the page falls back to the offline shelf — the own quests this
 * device remembers or holds — so a downloaded quest is reachable in the field.
 */

/** Facet option lists are the values the catalog actually has, ru-collated. */
const uniqRu = (values: string[]) =>
  Array.from(new Set(values)).sort((a, b) => a.localeCompare(b, 'ru'));

const NO_GRANTS: ReadonlyMap<string, string> = new Map();
const NO_IDS: ReadonlySet<string> = new Set();

/** Below this many quests in a city the filters cannot narrow anything worth
 *  narrowing: only the sort is offered (ТЗ, задача 17). */
const FILTERS_FROM = 6;

/** The hero photo, served at the width the screen needs (ТЗ, задача 8): the
 *  original PNG weighed 844 KB on every phone. */
const HERO_SRCSET = '/assets/img/hero-main-720.webp 720w, /assets/img/hero-main-1240.webp 1240w';
const HERO_SIZES = '(max-width: 767px) 100vw, 50vw';

export default function GeoQuestHome() {
  const mineOn = useRememberedClientFeature('store_my_quests');
  const citiesOn = useRememberedClientFeature('store_cities');
  const factsOn = useClientFeature('quest_facts');
  const soonCities = useSoonCities();
  const savedCity = useSavedCity();
  // Quests taken on this visit keep their place in the grid until the next one:
  // moving a card to the top the moment it is taken put another quest's «Купить»
  // under the same finger (ТЗ, задача 7).
  const [acquired, setAcquired] = useState<ReadonlySet<string>>(NO_IDS);
  // The shop head pins under the header on a phone; its shadow shows only then.
  const headSentinel = useRef<HTMLDivElement | null>(null);
  const headStuck = useStuck(headSentinel, HEADER_PIN_PX);
  // Once the list's end reaches the head's lower edge the head slides away
  // whole — the page may run out before the list has pushed it under the header.
  const listEndSentinel = useRef<HTMLDivElement | null>(null);
  const headLeaving = useStuck(listEndSentinel, HEADER_PIN_PX + SHOP_HEAD_PX);
  // `market` is the loaded list, or null on a catalog FAILURE; `marketLoading`
  // keeps the initial render distinct from a failure so loading never flashes
  // the error message.
  const [market, setMarket] = useState<PublishedQuestWire[] | null>(null);
  const [marketLoading, setMarketLoading] = useState(true);
  const [fetchRound, setFetchRound] = useState(0);
  const live = useOwned();
  const [shelf, setShelf] = useState<OfflineShelf | null>(null);
  const [statuses, setStatuses] = useState<Record<string, OwnedStatus> | null>(null);
  const [inProgress, setInProgress] = useState<InProgress | null>(null);

  const failed = !marketLoading && market === null;
  const offline = mineOn && failed && shelf !== null;
  const catalog = offline ? shelf.quests : market;
  const owned = offline ? shelf.owned : live.owned;
  const grantedAt = (offline ? shelf.grantedAt : live.grantedAt) ?? NO_GRANTS;

  // Facet options are the values the catalog actually has; they also tell the
  // URL state which values of the open sets (city, tag) are still real.
  const facetValues = useMemo(
    () =>
      catalog
        ? {
            cities: uniqRu(catalog.map((q) => q.city).filter((c): c is string => !!c)),
            tags: uniqRu(catalog.flatMap((q) => q.tags)),
          }
        : null,
    [catalog],
  );

  // The applied store state lives in the URL (lib/useStoreQuery); the toolbar
  // hands back a whole new query on apply and keeps only a draft until then.
  const [query, applyQuery] = useStoreQuery(facetValues);

  // The city the shop shows. With `store_cities` the player picks one (the URL
  // first, then this device's last pick, then the city with the most quests);
  // without it a single-city catalog still names its city in the hero.
  const cities = useMemo(() => facetValues?.cities ?? [], [facetValues]);
  const busiest = useMemo(() => (catalog ? busiestCity(catalog) : null), [catalog]);
  const urlCity = query.filters.city.length === 1 ? query.filters.city[0] : null;
  const activeCity = citiesOn
    ? (urlCity ?? (savedCity && cities.includes(savedCity) ? savedCity : busiest))
    : (urlCity ?? (cities.length === 1 ? cities[0] : null));
  const soon = citiesOn ? soonCities.filter((c) => !cities.includes(c)) : [];
  /** With city chips the city is theirs, not the filters' — the toolbar never sees it. */
  const withCity = useCallback(
    (f: FacetFilters): FacetFilters => (citiesOn && activeCity ? { ...f, city: [activeCity] } : f),
    [citiesOn, activeCity],
  );
  const toolbarQuery: StoreQuery = citiesOn ? { ...query, filters: { ...query.filters, city: [] } } : query;
  const applyToolbar = (next: StoreQuery) =>
    applyQuery(citiesOn ? { ...next, filters: { ...next.filters, city: query.filters.city } } : next);
  const pickCity = (city: string) => {
    saveCity(city);
    applyQuery({ ...query, filters: { ...query.filters, city: [city] } });
  };

  /** ONE predicate for the grid and for the toolbar's live «Показать N». */
  const matching = useCallback(
    (f: FacetFilters) =>
      catalog ? catalog.filter((q) => matchesAttrs(withCity(f), q, owned.has(q.quest_id))) : [],
    [catalog, owned, withCity],
  );

  /** The quests of the shown city (all of them while no city is picked). */
  const cityQuests = useMemo(
    () => (catalog ? (activeCity ? catalog.filter((q) => q.city === activeCity) : catalog) : []),
    [catalog, activeCity],
  );
  // Filters earn their place from FILTERS_FROM quests; until then they stay only
  // while one is applied (a shared link must stay undoable) or while they are
  // the sole way to pick among several cities (no city chips).
  const filtersOn =
    cityQuests.length >= FILTERS_FROM ||
    countActiveValues(toolbarQuery.filters) > 0 ||
    (!citiesOn && cities.length > 1);

  const visible = useMemo(() => {
    const list = matching(query.filters);
    if (!mineOn) return sortQuests(list, query.sort);
    const leads = (q: PublishedQuestWire) => owned.has(q.quest_id) && !acquired.has(q.quest_id);
    const mine = list.filter(leads);
    const rest = list.filter((q) => !leads(q));
    return [...orderOwned(mine, statuses ?? {}, grantedAt), ...sortQuests(rest, query.sort)];
  }, [matching, query, mineOn, owned, acquired, statuses, grantedAt]);

  const onAcquired = useCallback((questId: string) => {
    setAcquired((cur) => new Set(cur).add(questId));
  }, []);

  const facts = cityFacts(cityQuests, factsOn);
  const hasFree = cityQuests.some((q) => q.price === 0);
  const proof = useMemo(() => {
    const f = catalogFacts(cityQuests);
    const players = cityQuests.reduce((n, q) => n + q.players, 0);
    return f.avg == null ? null : { avg: f.avg, ratings: f.ratings, players };
  }, [cityQuests]);
  /** The quote comes from the city's most-rated quest — the likeliest to have one. */
  const quoteQuest = useMemo(
    () =>
      cityQuests.reduce<PublishedQuestWire | null>(
        (best, q) => (!best || q.rating_count > best.rating_count ? q : best),
        null,
      ),
    [cityQuests],
  );

  // The catalog is public and identity-free; the owned set comes from the
  // shared identity-keyed collection (lib/collection). A refetch (the network
  // came back) keeps the offline shelf on screen until the catalog lands.
  useEffect(() => {
    let cancelled = false;
    api.listQuests()
      .then((quests) => { if (!cancelled) setMarket(quests); })
      .catch(() => { if (!cancelled) setMarket(null); })
      .finally(() => { if (!cancelled) setMarketLoading(false); });
    return () => { cancelled = true; };
  }, [fetchRound]);

  // Remember what the offline shelf will need — only answers that arrived.
  useEffect(() => {
    if (mineOn && market) rememberCatalog(market);
  }, [mineOn, market]);
  useEffect(() => {
    if (mineOn && live.grantedAt) rememberGrants(currentUserId(), live.grantedAt);
  }, [mineOn, live.grantedAt]);

  // No catalog: fall back to the offline shelf, and retry once the network is back.
  useEffect(() => {
    if (!mineOn || !failed) return;
    let cancelled = false;
    void loadOfflineShelf(currentUserId()).then((s) => { if (!cancelled) setShelf(s); });
    const retry = () => setFetchRound((n) => n + 1);
    window.addEventListener('online', retry);
    return () => {
      cancelled = true;
      window.removeEventListener('online', retry);
    };
  }, [mineOn, failed]);

  // What this device knows of each own quest. Offline the published version is
  // unknown, so no update is claimed.
  useEffect(() => {
    if (!mineOn || !catalog) return;
    let cancelled = false;
    const mine = catalog.filter((q) => owned.has(q.quest_id));
    void Promise.all(
      mine.map(async (q) => [q.quest_id, await ownedStatus(q.quest_id, offline ? null : q.snapshot_id)] as const),
    ).then(
      (entries) => { if (!cancelled) setStatuses(Object.fromEntries(entries)); },
      () => { if (!cancelled) setStatuses({}); }, // storage unreadable — cards show as fresh
    );
    return () => { cancelled = true; };
  }, [mineOn, catalog, owned, offline]);

  useEffect(() => {
    if (!mineOn) return;
    let cancelled = false;
    latestInProgress().then((c) => { if (!cancelled) setInProgress(c); }, () => {});
    return () => { cancelled = true; };
  }, [mineOn]);

  /** A card downloaded or removed its quest: re-read what the device holds. */
  const refreshStatus = useCallback(
    (questId: string) => {
      const published = offline ? null : (catalog?.find((q) => q.quest_id === questId)?.snapshot_id ?? null);
      void ownedStatus(questId, published).then(
        (s) => setStatuses((cur) => ({ ...cur, [questId]: s })),
        () => {},
      );
      latestInProgress().then(setInProgress, () => {});
    },
    [catalog, offline],
  );

  // Own quests settle before the grid shows, so it doesn't reshuffle under the eye.
  const settling =
    mineOn && catalog !== null && ((!offline && !live.loaded) || (owned.size > 0 && statuses === null));
  const loading = marketLoading || (mineOn && failed && shelf === null) || settling;
  const continueQuest = mineOn && inProgress && (!offline || inProgress.downloaded) ? inProgress : null;

  return (
    <SiteShell>

      {/* HERO (ТЗ, задача 13): what it is, where, how long and for whom —
          the city in the headline, a light photo, three facts and the CTA. */}
      <section className="hero2" data-screen-label="Главная — хиро">
        {citiesOn && (cities.length > 1 || soon.length > 0) && (
          <div className="container">
            <CityChips cities={cities} soon={soon} active={activeCity} onPick={pickCity} />
          </div>
        )}
        <div className="container hero2__inner">
          <p className="hero2__over">Квесты-прогулки в смартфоне</p>
          <h1 className="hero2__title">{heroTitle(activeCity)}</h1>
          <p className="hero2__sub">
            Маршрут, загадки и история — в телефоне. Без гида и записи: в любой день, вдвоём или компанией.
          </p>
          <picture className="hero2__photo">
            <img
              src="/assets/img/hero-main-1240.webp"
              srcSet={HERO_SRCSET}
              sizes={HERO_SIZES}
              width={1240}
              height={480}
              alt="Две подруги проходят квест в смартфоне на улице старого города"
              fetchPriority="high"
            />
          </picture>
          {(facts.time || facts.distance || hasFree) && (
            <ul className="hero2__facts">
              {facts.time && <li><span className="ic ic-clock" aria-hidden />{facts.time}</li>}
              {facts.distance && <li><span className="ic ic-route" aria-hidden />{facts.distance} пешком</li>}
              {hasFree && <li className="is-free">Первый квест бесплатно</li>}
            </ul>
          )}
          <div className="hero2__cta">
            <HeroCta
              inProgress={continueQuest}
              name={continueQuest && (continueQuest.name ?? catalog?.find((q) => q.quest_id === continueQuest.questId)?.name)}
              hasOwn={mineOn && owned.size > 0}
              offline={offline}
            />
          </div>
          <p className="hero2__under">
            {proof && (
              <span className="hero2__proof">
                <span className="ic ic-star" aria-hidden /> <b>{fmtRating(proof.avg)}</b> · {proof.ratings}&nbsp;{ratingPlural(proof.ratings)}
                {showPlayers(proof.players, proof.ratings) && ` · ${proof.players} ${playerCountPlural(proof.players)}`}
              </span>
            )}
            <Link className="hero2__how" href="/rules">Как играть →</Link>
          </p>
        </div>
      </section>

      {/* §2.1/§2.2 store grid — live quests, purchase status inside the cards */}
      <section className="container store" id="shop" data-screen-label="Главная — магазин квестов">
        <div className="sticky-sentinel" ref={headSentinel} aria-hidden />
        {/* The head pins under the header on a phone and leaves with the
            section; the sort/filter control rides in it (a round button on a
            phone, the toolbar row under the title on a desktop). */}
        <div className={`store__head${headStuck ? ' is-stuck' : ''}${headLeaving ? ' is-leaving' : ''}`}>
          <h2 className="store__title">{questsInCity(activeCity)}</h2>
          {cityQuests.length > 0 && (
            <span className="store__count">{cityQuests.length}&nbsp;{questPlural(cityQuests.length)}</span>
          )}
          {!loading && catalog !== null && catalog.length > 0 && (
            <StoreToolbar
              query={toolbarQuery}
              onApply={applyToolbar}
              filtersOn={filtersOn}
              cities={citiesOn ? [] : cities}
              tags={facetValues?.tags ?? []}
              /* Offered to a viewer who owns something — and always kept
                 reachable while it is ON, so a link carrying it (or a failed
                 grants load) never leaves an unswitchable filter behind.
                 Offline every card is the viewer's own: nothing to hide. */
              showOwnedToggle={(!offline && owned.size > 0) || query.filters.hideOwned}
              countFor={(f) => matching(f).length}
            />
          )}
        </div>
        {offline && (
          <p className="shop-note">
            Нет сети. Ниже — ваши квесты на этом устройстве. Новые можно будет купить, когда появится связь.
          </p>
        )}
        {loading ? (
          <p className="shop-note">Загружаем магазин…</p>
        ) : catalog === null ? (
          <p className="shop-note shop-note--error">
            Не удалось загрузить магазин — проверьте подключение и обновите страницу.
          </p>
        ) : catalog.length === 0 ? (
          <p className="shop-note">
            {offline ? 'На этом устройстве нет ваших квестов.' : 'Скоро здесь появятся квесты.'}
          </p>
        ) : (
          <div className="quest-grid">
            {visible.length === 0 ? (
              <p className="shop-note shop-note--grid">
                Ничего не нашлось.{' '}
                <button
                  type="button"
                  className="shop-note__reset"
                  onClick={() => applyToolbar({ filters: EMPTY_FACETS, sort: query.sort })}
                >
                  Сбросить фильтры
                </button>
              </p>
            ) : (
              visible.map((q) => (
                <QuestCard
                  key={q.quest_id}
                  quest={q}
                  owned={owned.has(q.quest_id)}
                  mine={
                    mineOn
                      ? { status: statuses?.[q.quest_id] ?? null, offline, onChange: refreshStatus, onAcquired }
                      : undefined
                  }
                />
              ))
            )}
          </div>
        )}
        <div className="sticky-sentinel" ref={listEndSentinel} aria-hidden />
      </section>

      {!offline && (
        <div className="container store-after">
          {quoteQuest && <PlayerQuote questId={quoteQuest.quest_id} questName={quoteQuest.name} />}
          <TogetherBlock />
          {soon.length > 0 && <SoonBlock cities={soon} />}
        </div>
      )}

    </SiteShell>
  );
}

/**
 * The hero's one button: straight back into the quest in progress, else down to
 * the own quests leading the grid, else the shop. Offline it is a real
 * navigation, so the service worker serves the cached player page.
 */
function HeroCta({
  inProgress,
  name,
  hasOwn,
  offline,
}: {
  inProgress: InProgress | null;
  name: string | null | undefined;
  hasOwn: boolean;
  offline: boolean;
}) {
  if (inProgress) {
    const href = `/quest/${encodeURIComponent(inProgress.questId)}`;
    const label = <span className="hero__cta-text">{name ? `Продолжить «${name}»` : 'Продолжить квест'}</span>;
    return offline ? (
      <a className="btn hero__cta--continue" href={href}>{label}</a>
    ) : (
      <Link className="btn hero__cta--continue" href={href}>{label}</Link>
    );
  }
  return <a className="btn" href="#shop">{hasOwn ? 'Мои квесты' : 'Выбрать квест'}</a>;
}
