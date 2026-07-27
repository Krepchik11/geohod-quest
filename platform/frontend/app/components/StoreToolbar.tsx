'use client';

import React, { useCallback, useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { AGE_TARGET_OPTIONS, COMPLEXITY_OPTIONS } from '../../lib/constructor-model';
import { PHONE_QUERY } from '../../lib/breakpoints';
import { questPlural } from '../../lib/storefront';
import {
  EMPTY_FACETS,
  PRICE_OPTIONS,
  countActiveValues,
  type FacetFilters,
  type FacetKey,
} from '../../lib/quest-filters';
import { DEFAULT_SORT, SORT_OPTIONS, type StoreQuery, type StoreSort } from '../../lib/store-query';

/**
 * The store toolbar (§2.1) — the first row of the card grid, so its left edge
 * meets the first card at any width. Desktop shows two buttons with their own
 * popovers, a phone one button that opens a bottom sheet with sorting as its
 * first block: two sheets for one intent («сузить выдачу») would cost two
 * openings and two confirmations on a phone.
 *
 * The panel is a DRAFT of the applied query. Filters accumulate and commit once,
 * via «Показать N квестов», so one apply is one history entry; Escape and an
 * outside click throw the draft away. Sorting is a single value that never
 * changes N, so in the sort popover it commits on click; inside the sheet it is
 * part of the same form — a sheet must not be yanked out from under the finger
 * halfway through. Which panel is open decides that, not the viewport.
 *
 * The constructor keeps its own expanded bar (quest-editor/QuestFilters); only
 * the data rules (lib/quest-filters, lib/store-query) are shared.
 */

export interface StoreToolbarProps {
  /** The APPLIED state — the URL is its source of truth. */
  query: StoreQuery;
  /** Commit: exactly one call per apply. */
  onApply: (next: StoreQuery) => void;
  /** Cities/tags that actually exist in the catalog (sorted by the caller). */
  cities: string[];
  tags: string[];
  /** «Только не купленные» is shown only to a viewer who owns something — a
   *  filter that cannot change the result must not be offered. */
  showOwnedToggle: boolean;
  /** Live N for the draft; the page owns the catalog. */
  countFor: (filters: FacetFilters) => number;
}

type OpenPanel = 'none' | 'filters' | 'sort' | 'sheet';

/** One lazily-created MediaQueryList shared by the subscription and the reads:
 *  `getSnapshot` runs on every render and must not allocate. */
let phoneMql: MediaQueryList | null | undefined;
const phoneQuery = () =>
  (phoneMql ??=
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia(PHONE_QUERY)
      : null);

function subscribeViewport(onChange: () => void) {
  const mql = phoneQuery();
  if (!mql) return () => {};
  mql.addEventListener('change', onChange);
  return () => mql.removeEventListener('change', onChange);
}

/** Server renders the desktop layout; the client corrects it on mount. */
function useIsPhone(): boolean {
  return useSyncExternalStore(
    subscribeViewport,
    () => phoneQuery()?.matches ?? false,
    () => false,
  );
}

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), [tabindex]:not([tabindex="-1"])';
const focusablesIn = (el: HTMLElement) => Array.from(el.querySelectorAll<HTMLElement>(FOCUSABLE));

export default function StoreToolbar({
  query,
  onApply,
  cities,
  tags,
  showOwnedToggle,
  countFor,
}: StoreToolbarProps) {
  const isPhone = useIsPhone();
  const [open, setOpen] = useState<OpenPanel>('none');
  const [draft, setDraft] = useState<StoreQuery>(query);

  const rootRef = useRef<HTMLDivElement | null>(null);
  const sheetRef = useRef<HTMLDivElement | null>(null);
  const lastTrigger = useRef<HTMLButtonElement | null>(null);

  const close = useCallback(() => {
    setOpen('none');
    lastTrigger.current?.focus();
  }, []);

  /** Opening always re-drafts from the applied state — a discarded draft is gone. */
  const openPanel = (panel: Exclude<OpenPanel, 'none'>, trigger: HTMLButtonElement) => {
    if (open === panel) {
      close();
      return;
    }
    lastTrigger.current = trigger;
    setDraft(query);
    setOpen(panel);
  };

  // Escape and an outside click close every panel WITHOUT committing.
  const isOpen = open !== 'none';
  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    const onPointer = (e: MouseEvent) => {
      const target = e.target as Node;
      // The sheet is portalled out of the toolbar, so it needs its own test.
      if (rootRef.current?.contains(target) || sheetRef.current?.contains(target)) return;
      close();
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onPointer);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onPointer);
    };
  }, [isOpen, close]);

  // The sheet is modal: focus moves into it, the page behind it stops
  // scrolling, and both are undone the moment it closes.
  useEffect(() => {
    if (open !== 'sheet') return;
    const el = sheetRef.current;
    if (el) focusablesIn(el)[0]?.focus();
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previous;
    };
  }, [open]);

  const trapFocus = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'Tab' || !sheetRef.current) return;
    const items = focusablesIn(sheetRef.current);
    if (items.length === 0) return;
    const first = items[0];
    const last = items[items.length - 1];
    const active = document.activeElement;
    if (e.shiftKey && (active === first || !sheetRef.current.contains(active))) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      first.focus();
    }
  };

  const setFilters = (next: FacetFilters) => setDraft((d) => ({ ...d, filters: next }));

  const toggleValue = (key: FacetKey, value: string) =>
    setDraft((d) => {
      const cur = d.filters[key] as string[];
      const next = cur.includes(value) ? cur.filter((v) => v !== value) : [...cur, value];
      return { ...d, filters: { ...d.filters, [key]: next } };
    });

  const cityOptions = useMemo(() => cities.map((c) => ({ key: c, label: c })), [cities]);
  const tagOptions = useMemo(() => tags.map((t) => ({ key: t, label: t })), [tags]);

  const appliedCount = countActiveValues(query.filters);
  const sortLabel = (SORT_OPTIONS.find((s) => s.key === query.sort) ?? SORT_OPTIONS[0]).label;
  /** Sorting belongs to the form only where the form contains it. */
  const sortInForm = open === 'sheet';
  const canReset =
    countActiveValues(draft.filters) > 0 || (sortInForm && draft.sort !== DEFAULT_SORT);

  const applyDraft = () => {
    onApply({ filters: draft.filters, sort: sortInForm ? draft.sort : query.sort });
    close();
  };

  const resetDraft = () =>
    setDraft((d) => ({ filters: EMPTY_FACETS, sort: sortInForm ? DEFAULT_SORT : d.sort }));

  const pickSortNow = (sort: StoreSort) => {
    onApply({ ...query, sort });
    close();
  };

  const badge = appliedCount > 0 ? <span className="stb-badge">{appliedCount}</span> : null;

  return (
    <div className="stb" ref={rootRef}>
      {isPhone ? (
        <button
          type="button"
          className={`btn btn--quiet btn--md btn--block stb-btn${appliedCount > 0 ? ' is-active' : ''}`}
          aria-haspopup="dialog"
          aria-expanded={open === 'sheet'}
          onClick={(e) => openPanel('sheet', e.currentTarget)}
        >
          Фильтры и сортировка
          {badge}
          <span className="stb-caret" aria-hidden />
        </button>
      ) : (
        <>
          <div className="stb-anchor">
            <button
              type="button"
              className={`btn btn--quiet btn--sm stb-btn${appliedCount > 0 ? ' is-active' : ''}`}
              aria-haspopup="dialog"
              aria-expanded={open === 'filters'}
              onClick={(e) => openPanel('filters', e.currentTarget)}
            >
              Фильтры
              {badge}
              <span className="stb-caret" aria-hidden />
            </button>
            {open === 'filters' && (
              <div className="stb-pop" role="dialog" aria-label="Фильтры">
                <div className="stb-pop__body">
                  <Facets
                    filters={draft.filters}
                    cities={cityOptions}
                    tags={tagOptions}
                    showOwnedToggle={showOwnedToggle}
                    onToggleValue={toggleValue}
                    onChange={setFilters}
                  />
                </div>
                <div className="stb-pop__foot">
                  <ApplyButton className="btn btn--md stb-apply" count={countFor(draft.filters)} onClick={applyDraft} />
                  <ResetButton disabled={!canReset} onClick={resetDraft} />
                </div>
              </div>
            )}
          </div>

          <div className="stb-anchor">
            <button
              type="button"
              className="btn btn--quiet btn--sm stb-btn"
              aria-haspopup="dialog"
              aria-expanded={open === 'sort'}
              onClick={(e) => openPanel('sort', e.currentTarget)}
            >
              Сортировка: <span className="stb-btn__value">{sortLabel}</span>
              <span className="stb-caret" aria-hidden />
            </button>
            {open === 'sort' && (
              <div className="stb-pop stb-pop--sort" role="dialog" aria-label="Сортировка">
                <SortOptions value={query.sort} onPick={pickSortNow} />
              </div>
            )}
          </div>
        </>
      )}

      {/* The sheet leaves the grid's stacking context entirely: nested in the
          toolbar it would lose to the fixed mobile tab bar (z-index 50). */}
      {open === 'sheet' && typeof document !== 'undefined' && createPortal(
        <div className="sheet__ovl stb-overlay" onMouseDown={(e) => e.target === e.currentTarget && close()}>
          <div
            className="sheet stb-sheet"
            role="dialog"
            aria-modal="true"
            aria-label="Фильтры и сортировка"
            ref={sheetRef}
            onKeyDown={trapFocus}
          >
            <span className="sheet__grip" aria-hidden />
            <div className="stb-sheet__head">
              <h3>Фильтры и сортировка</h3>
              <ResetButton disabled={!canReset} onClick={resetDraft} />
            </div>
            <div className="stb-sheet__body">
              <FieldGroup label="Сортировка">
                <SortOptions value={draft.sort} onPick={(sort) => setDraft((d) => ({ ...d, sort }))} />
              </FieldGroup>
              <hr className="stb-sheet__rule" />
              <Facets
                filters={draft.filters}
                cities={cityOptions}
                tags={tagOptions}
                showOwnedToggle={showOwnedToggle}
                onToggleValue={toggleValue}
                onChange={setFilters}
              />
            </div>
            <ApplyButton className="btn btn--block" count={countFor(draft.filters)} onClick={applyDraft} />
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}

type Options = ReadonlyArray<{ key: string; label: string }>;

/** The six facet controls — identical in the popover and the sheet; only their
 *  size differs, and that is CSS (`.stb-sheet` descendants). */
function Facets({
  filters,
  cities,
  tags,
  showOwnedToggle,
  onToggleValue,
  onChange,
}: {
  filters: FacetFilters;
  cities: Options;
  tags: Options;
  showOwnedToggle: boolean;
  onToggleValue: (key: FacetKey, value: string) => void;
  onChange: (next: FacetFilters) => void;
}) {
  const groups: Array<{ key: FacetKey; label: string; options: Options }> = [
    { key: 'city', label: 'Город', options: cities },
    { key: 'price', label: 'Цена', options: PRICE_OPTIONS },
    { key: 'complexity', label: 'Сложность', options: COMPLEXITY_OPTIONS },
    { key: 'age', label: 'Возраст', options: AGE_TARGET_OPTIONS },
    { key: 'tag', label: 'Тег', options: tags },
  ];
  return (
    <>
      {groups.map((g) => (
        <FacetGroup
          key={g.key}
          label={g.label}
          options={g.options}
          selected={filters[g.key]}
          onToggle={(v) => onToggleValue(g.key, v)}
        />
      ))}
      {showOwnedToggle && (
        <button
          type="button"
          className="stb-switch"
          aria-pressed={filters.hideOwned}
          onClick={() => onChange({ ...filters, hideOwned: !filters.hideOwned })}
        >
          <span>Только не купленные</span>
          <span className={`stb-switch__track${filters.hideOwned ? ' is-on' : ''}`} aria-hidden />
        </button>
      )}
    </>
  );
}

function ApplyButton({ className, count, onClick }: { className: string; count: number; onClick: () => void }) {
  return (
    <button type="button" className={className} onClick={onClick}>
      Показать {count} {questPlural(count)}
    </button>
  );
}

function ResetButton({ disabled, onClick }: { disabled: boolean; onClick: () => void }) {
  return (
    <button type="button" className="stb-reset" onClick={onClick} disabled={disabled}>
      Сбросить
    </button>
  );
}

/** A labelled block; the visible label names the group for assistive tech. */
function FieldGroup({ label, children }: { label: string; children: React.ReactNode }) {
  const id = useId();
  return (
    <div className="stb-facet" role="group" aria-labelledby={id}>
      <span className="stb-facet__label" id={id}>{label}</span>
      {children}
    </div>
  );
}

function FacetGroup({
  label,
  options,
  selected,
  onToggle,
}: {
  label: string;
  options: Options;
  selected: readonly string[];
  onToggle: (value: string) => void;
}) {
  if (options.length === 0) return null;
  return (
    <FieldGroup label={label}>
      <div className="stb-chips">
        {options.map((o) => {
          const on = selected.includes(o.key);
          return (
            <button
              key={o.key}
              type="button"
              className={`stb-chip${on ? ' is-on' : ''}`}
              aria-pressed={on}
              onClick={() => onToggle(o.key)}
            >
              {/* A tick, not just a fill: a fill reads as «one of», and a set
                  must be distinguishable from a switch. */}
              {on && <span className="stb-chip__tick" aria-hidden>✓</span>}
              {o.label}
            </button>
          );
        })}
      </div>
    </FieldGroup>
  );
}

function SortOptions({ value, onPick }: { value: StoreSort; onPick: (key: StoreSort) => void }) {
  return (
    <div className="stb-sorts">
      {SORT_OPTIONS.map((s) => (
        <button
          key={s.key}
          type="button"
          className={`stb-sort${s.key === value ? ' is-on' : ''}`}
          aria-pressed={s.key === value}
          onClick={() => onPick(s.key)}
        >
          {s.full}
          {s.key === value && <span className="stb-sort__tick" aria-hidden>✓</span>}
        </button>
      ))}
    </div>
  );
}
