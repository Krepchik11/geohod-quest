'use client'; // narrow island ONLY for the live catalog + owned set (§2)

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import SiteShell from './components/SiteShell';
import QuestCard from './components/QuestCard';
import StoreToolbar from './components/StoreToolbar';
import { api, type PublishedQuestWire } from '../lib/api';
import { useRememberedClientFeature } from '../lib/client-features';
import { useOwned } from '../lib/collection';
import { currentUserId } from '../lib/identity';
import { loadOfflineShelf, rememberCatalog, rememberGrants, type OfflineShelf } from '../lib/offline-shelf';
import { latestInProgress, orderOwned, ownedStatus, type InProgress, type OwnedStatus } from '../lib/owned-quests';
import { EMPTY_FACETS, matchesAttrs, type FacetFilters } from '../lib/quest-filters';
import { sortQuests } from '../lib/store-query';
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

export default function GeoQuestHome() {
  const mineOn = useRememberedClientFeature('store_my_quests');
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

  /** ONE predicate for the grid and for the toolbar's live «Показать N». */
  const matching = useCallback(
    (f: FacetFilters) =>
      catalog ? catalog.filter((q) => matchesAttrs(f, q, owned.has(q.quest_id))) : [],
    [catalog, owned],
  );

  const visible = useMemo(() => {
    const list = matching(query.filters);
    if (!mineOn) return sortQuests(list, query.sort);
    const mine = list.filter((q) => owned.has(q.quest_id));
    const rest = list.filter((q) => !owned.has(q.quest_id));
    return [...orderOwned(mine, statuses ?? {}, grantedAt), ...sortQuests(rest, query.sort)];
  }, [matching, query, mineOn, owned, statuses, grantedAt]);

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

      {/* HERO — §2.3: headline + CTA. */}
      <section className="hero" style={{ backgroundImage: "url('/assets/img/hero-main.png')" }} data-screen-label="Главная — хиро">
        <div className="hero__inner container">
          <h1 className="hero__title display">авторские<br />квесты</h1>
          <p className="hero__subtitle">Смотри на город по-новому!</p>
          <HeroCta
            inProgress={continueQuest}
            name={continueQuest && (continueQuest.name ?? catalog?.find((q) => q.quest_id === continueQuest.questId)?.name)}
            hasOwn={mineOn && owned.size > 0}
            offline={offline}
          />
        </div>
      </section>

      {/* §2.1/§2.2 store grid — live quests, purchase status inside the cards */}
      <section className="container container--wide" id="shop" style={{ paddingTop: 90 }} data-screen-label="Главная — магазин квестов">
        <h2 className="section-title display">магазин квестов</h2>
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
                 grants load) never leaves an unswitchable filter behind.
                 Offline every card is the viewer's own: nothing to hide. */
              showOwnedToggle={(!offline && owned.size > 0) || query.filters.hideOwned}
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
                <QuestCard
                  key={q.quest_id}
                  quest={q}
                  owned={owned.has(q.quest_id)}
                  mine={mineOn ? { status: statuses?.[q.quest_id] ?? null, offline, onChange: refreshStatus } : undefined}
                />
              ))
            )}
          </div>
        )}
      </section>

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
