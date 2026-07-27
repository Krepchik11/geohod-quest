'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  DEFAULT_STORE_QUERY,
  parseStoreQuery,
  pruneUnknownFacets,
  serializeStoreQuery,
  type StoreQuery,
} from './store-query';

/**
 * The store shelf's URL state (§2.1) — one home for the whole history dance, so
 * a filtered shelf can be sent, bookmarked and reached with the back button:
 *
 * - the URL is read on mount and on every back/forward;
 * - applying pushes ONE entry, and re-applying an unchanged state pushes none;
 * - a value the loaded catalog does not have (a link with an old tag) is
 *   dropped, and the URL is corrected with replaceState — a correction of the
 *   current entry, never a navigation.
 *
 * Pruning is DERIVED, not stored: the state is what the URL said, the applied
 * query is that minus the unknown values, and the effect only syncs the address
 * bar with it (the external system an effect is actually for). `known` may be
 * null while the catalog loads — pruning simply waits for it.
 *
 * Next's App Router picks up native pushState/replaceState (its own docs,
 * «Shallow routing on the client»), so no router call is needed.
 */
export function useStoreQuery(known: { cities: string[]; tags: string[] } | null): [
  StoreQuery,
  (next: StoreQuery) => void,
] {
  const [fromUrl, setFromUrl] = useState<StoreQuery>(DEFAULT_STORE_QUERY);

  useEffect(() => {
    const read = () => setFromUrl(parseStoreQuery(window.location.search));
    read();
    window.addEventListener('popstate', read);
    return () => window.removeEventListener('popstate', read);
  }, []);

  const query = useMemo(() => {
    if (!known) return fromUrl;
    const filters = pruneUnknownFacets(fromUrl.filters, known);
    return filters === fromUrl.filters ? fromUrl : { ...fromUrl, filters };
  }, [fromUrl, known]);

  // The address bar must show the query that is actually applied — it differs
  // only when something was pruned out of it.
  useEffect(() => {
    if (!sameAsUrl(query)) window.history.replaceState(null, '', storeUrl(query));
  }, [query]);

  const apply = useCallback((next: StoreQuery) => {
    setFromUrl(next);
    if (!sameAsUrl(next)) window.history.pushState(null, '', storeUrl(next));
  }, []);

  return [query, apply];
}

/** Both sides through the codec: the browser stores the query percent-encoded,
 *  we write it readable, and only the canonical form compares. */
const sameAsUrl = (q: StoreQuery) =>
  serializeStoreQuery(q) === serializeStoreQuery(parseStoreQuery(window.location.search));

/** Keeps the pathname and the #shop anchor; only the query changes. */
const storeUrl = (q: StoreQuery) =>
  `${window.location.pathname}${serializeStoreQuery(q)}${window.location.hash}`;
