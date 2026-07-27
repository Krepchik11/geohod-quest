'use client';

import { useCallback, useEffect, useState } from 'react';
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
 *   dropped and the URL corrected with replaceState — that is a correction of
 *   the current entry, not a navigation.
 *
 * `known` may be empty while the catalog loads; pruning simply waits for it.
 * Next's App Router picks up native pushState/replaceState (its own docs,
 * «Shallow routing on the client»), so no router call is needed.
 */
export function useStoreQuery(known: { cities: string[]; tags: string[] } | null): [
  StoreQuery,
  (next: StoreQuery) => void,
] {
  const [query, setQuery] = useState<StoreQuery>(DEFAULT_STORE_QUERY);

  useEffect(() => {
    const read = () => setQuery(parseStoreQuery(window.location.search));
    read();
    window.addEventListener('popstate', read);
    return () => window.removeEventListener('popstate', read);
  }, []);

  useEffect(() => {
    if (!known) return;
    const filters = pruneUnknownFacets(query.filters, known);
    if (filters === query.filters) return;
    const next = { ...query, filters };
    setQuery(next);
    window.history.replaceState(null, '', storeUrl(next));
  }, [known, query]);

  const apply = useCallback((next: StoreQuery) => {
    setQuery(next);
    // Both sides through the codec: the browser stores the query percent-encoded,
    // we write it readable, and only the canonical form compares.
    if (serializeStoreQuery(next) !== serializeStoreQuery(parseStoreQuery(window.location.search))) {
      window.history.pushState(null, '', storeUrl(next));
    }
  }, []);

  return [query, apply];
}

/** Keeps the pathname and the #shop anchor; only the query changes. */
const storeUrl = (q: StoreQuery) =>
  `${window.location.pathname}${serializeStoreQuery(q)}${window.location.hash}`;
