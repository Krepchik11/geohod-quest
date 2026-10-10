'use client'; // narrow island ONLY for the live catalog + owned set (§2)

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import SiteShell from './components/SiteShell';
import QuestCard from './components/QuestCard';
import StoreToolbar from './components/StoreToolbar';
import CityTitle from './components/CityTitle';
import CityHero from './components/CityHero';
import ShopSection, { HEADER_PIN_PX } from './components/ShopSection';
import { PlayerQuote, SoonBlock, TogetherBlock } from './components/StoreBlocks';
import { api, type CityWire, type PublishedQuestWire } from '../lib/api';
import { coverSrc } from '../lib/cover';
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
  citiesByCount,
  catalogFacts,
  heroSlogan,
  heroStats,
  questPlural,
} from '../lib/storefront';
import { useStoreQuery } from '../lib/useStoreQuery';

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

/** The shop heads pin under the header — a phone (styles/storefront.css). */
const pinsOnPhone = (shop: HTMLElement): boolean => {
  const head = shop.querySelector('.store__head');
  return !!head && getComputedStyle(head).position === 'sticky';
};

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
  const shopRef = useRef<HTMLElement | null>(null);
  // A city picked inside the feed restarts it: its start comes up into view —
  // a counter, so a pick of the city that already leads scrolls up as well.
  const [shopTopRound, setShopTopRound] = useState(0);
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
  // The admin's picture and slogan per city (the «Города» page); null until
  // they arrive — and for good offline, where the banner keeps its plain plate.
  const [cityRows, setCityRows] = useState<readonly CityWire[] | null>(null);

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
  /** With `store_cities` the shop is a feed of every city — the URL's city only
   *  leads it, so it never narrows the cards (nor reaches the toolbar). */
  const feedFilters = useCallback(
    (f: FacetFilters): FacetFilters => (citiesOn ? { ...f, city: [] } : f),
    [citiesOn],
  );
  const toolbarQuery: StoreQuery = citiesOn ? { ...query, filters: { ...query.filters, city: [] } } : query;
  const applyToolbar = (next: StoreQuery) =>
    applyQuery(citiesOn ? { ...next, filters: { ...next.filters, city: query.filters.city } } : next);
  const pickCity = (city: string) => {
    saveCity(city);
    applyQuery({ ...query, filters: { ...query.filters, city: [city] } });
  };
  /** The title's city list (`store_cities`): the busiest city first. */
  const cityCounts = useMemo(() => (catalog ? citiesByCount(catalog) : []), [catalog]);
  const pickCityInTitle = (city: string) => {
    // Picked inside the feed (its start already scrolled by): the feed restarts
    // from the picked city, so its start comes up instead of some other city's
    // middle — on a phone right under the pinned header.
    const shop = shopRef.current;
    if (shop && shop.getBoundingClientRect().top < (pinsOnPhone(shop) ? HEADER_PIN_PX : 0)) {
      setShopTopRound((n) => n + 1);
    }
    pickCity(city);
  };

  /** ONE predicate for the grid and for the toolbar's live «Показать N». A
   *  quest without a city has no place in a feed of cities. */
  const matching = useCallback(
    (f: FacetFilters) =>
      catalog
        ? catalog.filter(
            (q) => (!citiesOn || !!q.city) && matchesAttrs(feedFilters(f), q, owned.has(q.quest_id)),
          )
        : [],
    [catalog, owned, citiesOn, feedFilters],
  );

  /** The quests of the shown city (all of them while no city is picked). */
  const cityQuests = useMemo(
    () => (catalog ? (activeCity ? catalog.filter((q) => q.city === activeCity) : catalog) : []),
    [catalog, activeCity],
  );
  /** What the shop lays out: the whole feed of cities, or the one shown city. */
  const shopCount = citiesOn ? (catalog ?? []).filter((q) => !!q.city).length : cityQuests.length;
  // Filters earn their place from FILTERS_FROM quests; until then they stay only
  // while one is applied (a shared link must stay undoable) or while they are
  // the sole way to pick among several cities (no city chips).
  const filtersOn =
    shopCount >= FILTERS_FROM ||
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

  /** The shop's runs (`store_cities`): the picked city first, then the others,
   *  the busiest first; a city the filters leave empty drops out of the feed.
   *  Without the flag the shop is one run. */
  const runs = useMemo(() => {
    if (!citiesOn) return [{ city: activeCity, quests: visible }];
    const order = [activeCity, ...cityCounts.map((c) => c.city).filter((c) => c !== activeCity)];
    return order
      .filter((c): c is string => !!c)
      .map((city) => ({ city, quests: visible.filter((q) => q.city === city) }))
      .filter((run) => run.quests.length > 0);
  }, [citiesOn, activeCity, cityCounts, visible]);

  useEffect(() => {
    if (shopTopRound === 0) return;
    const shop = shopRef.current;
    const sentinel = shop?.querySelector<HTMLElement>('.sticky-sentinel');
    if (!shop || !sentinel) return;
    // On a phone the first head's 1px sentinel goes wholly past the pin line
    // (touching it still counts as in view), so the head lands pinned and
    // shadowed; a desktop gets the head a little below the window's top.
    const offset = pinsOnPhone(shop) ? HEADER_PIN_PX - 2 : 24;
    window.scrollTo({ top: sentinel.getBoundingClientRect().top + window.scrollY - offset });
  }, [shopTopRound]);

  const onAcquired = useCallback((questId: string) => {
    setAcquired((cur) => new Set(cur).add(questId));
  }, []);

  /** The city's average rating — absent only while none of its quests is rated. */
  const proof = useMemo(() => {
    const f = catalogFacts(cityQuests);
    return f.avg == null ? null : { avg: f.avg, ratings: f.ratings };
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

  useEffect(() => {
    let cancelled = false;
    api.listCities().then((rows) => { if (!cancelled) setCityRows(rows); }, () => {});
    return () => { cancelled = true; };
  }, []);

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
  const continueName =
    continueQuest && (continueQuest.name ?? catalog?.find((q) => q.quest_id === continueQuest.questId)?.name);
  const cityRow = cityRows?.find((r) => r.name === activeCity) ?? null;

  return (
    <SiteShell>

      {/* The main banner (owner, 2026-10-10): one title, the city buttons, the
          picked city's photo with its slogan and numbers, «Выбрать квест». */}
      <CityHero
        city={activeCity}
        cities={citiesOn ? cityCounts : []}
        soon={soon}
        onPick={pickCity}
        image={coverSrc(cityRow?.image)}
        slogan={heroSlogan(activeCity, cityRow?.slogan)}
        stats={heroStats(cityQuests, factsOn)}
        proof={proof}
        continueTo={
          continueQuest
            ? { href: `/quest/${encodeURIComponent(continueQuest.questId)}`, name: continueName ?? null, offline }
            : null
        }
      />

      {/* §2.1/§2.2 store grid — live quests, purchase status inside the cards */}
      <section className="container store" id="shop" ref={shopRef} data-screen-label="Главная — магазин квестов">
        {/* A run per city (`store_cities`), the picked one first. Each head
            pins under the header on a phone until the next city's head pushes
            it out; the sort/filter control rides in every head on a phone (a
            round button), on a desktop only the first head has the toolbar. */}
        {(runs.length > 0 ? runs : [{ city: activeCity, quests: [] }]).map((run, i, all) => (
          <ShopSection
            key={run.city ?? ''}
            last={i === all.length - 1}
            head={
              <>
                <CityTitle city={run.city} cities={citiesOn ? cityCounts : null} onPick={pickCityInTitle} />
                {run.quests.length > 0 && (
                  <span className="store__count">{run.quests.length}&nbsp;{questPlural(run.quests.length)}</span>
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
                    phoneOnly={i > 0}
                  />
                )}
              </>
            }
          >
            {i === 0 && offline && (
              <p className="shop-note">
                Нет сети. Ниже — ваши квесты на этом устройстве. Новые можно будет купить, когда появится связь.
              </p>
            )}
            {i === 0 &&
              (loading ? (
                <p className="shop-note">Загружаем магазин…</p>
              ) : catalog === null ? (
                <p className="shop-note shop-note--error">
                  Не удалось загрузить магазин — проверьте подключение и обновите страницу.
                </p>
              ) : catalog.length === 0 ? (
                <p className="shop-note">
                  {offline ? 'На этом устройстве нет ваших квестов.' : 'Скоро здесь появятся квесты.'}
                </p>
              ) : null)}
            {!loading && catalog !== null && catalog.length > 0 && (
              <div className="quest-grid">
                {run.quests.length === 0 ? (
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
                  run.quests.map((q) => (
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
          </ShopSection>
        ))}
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
