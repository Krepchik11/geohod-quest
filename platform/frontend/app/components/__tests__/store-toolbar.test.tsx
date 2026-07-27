// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import React from 'react';

import StoreToolbar from '../StoreToolbar';
import {
  EMPTY_FACETS,
  countActiveValues,
  matchesAttrs,
  type FacetFilters,
} from '../../../lib/quest-filters';
import { DEFAULT_SORT, type StoreQuery } from '../../../lib/store-query';

/**
 * The toolbar is a DRAFT over the applied state: nothing leaves it until
 * «Показать N квестов». Escape and an outside click throw the draft away.
 * The badge counts chosen values, so it always equals what the panel shows.
 */

const CITIES = ['Белград', 'Земун', 'Ниш'];
const TAGS = ['еда', 'история', 'легенды'];

const CATALOG = [
  { city: 'Белград', price: 890, complexity: 'medium', age_target: 'everyone', tags: ['история'] },
  { city: 'Белград', price: 0, complexity: 'low', age_target: 'everyone', tags: ['легенды', 'еда'] },
  { city: 'Земун', price: 690, complexity: 'low', age_target: 'kids', tags: ['еда'] },
  { city: 'Ниш', price: 990, complexity: 'high', age_target: '18plus', tags: ['история'] },
];
const countFor = (f: FacetFilters) => CATALOG.filter((q) => matchesAttrs(f, q)).length;

/**
 * jsdom has no matchMedia (a missing one reads as desktop). The stub mirrors a
 * real MediaQueryList: ONE live object per query whose `matches` follows the
 * viewport — the toolbar caches it exactly as it would in a browser.
 */
let phone = false;
Object.defineProperty(window, 'matchMedia', {
  configurable: true,
  writable: true,
  value: (media: string) => ({
    media,
    get matches() {
      return phone && media.includes('max-width');
    },
    addEventListener: () => {},
    removeEventListener: () => {},
  }),
});
const setViewport = (mobile: boolean) => {
  phone = mobile;
};

function setup(over: Partial<React.ComponentProps<typeof StoreToolbar>> = {}) {
  const onApply = vi.fn();
  const query: StoreQuery = over.query ?? { filters: EMPTY_FACETS, sort: DEFAULT_SORT };
  const view = render(
    <StoreToolbar
      query={query}
      onApply={onApply}
      cities={CITIES}
      tags={TAGS}
      showOwnedToggle
      countFor={countFor}
      {...over}
    />,
  );
  return { onApply, view };
}

const filtersButton = () => screen.getByRole('button', { name: /^Фильтры/ });
const chip = (label: string) => screen.getByRole('button', { name: label });
const applyButton = () => screen.getByRole('button', { name: /Показать/ });
const resetButton = () => screen.getByRole('button', { name: 'Сбросить' });

beforeEach(() => setViewport(false));
afterEach(() => vi.restoreAllMocks());

describe('StoreToolbar — the buttons', () => {
  it('shows no badge with nothing applied and marks the button inactive', () => {
    setup();
    const btn = filtersButton();
    expect(btn).toHaveAttribute('aria-expanded', 'false');
    expect(btn.className).not.toMatch(/is-active/);
    expect(btn.textContent).not.toMatch(/\d/);
  });

  it('the badge counts VALUES, not facets', () => {
    const filters: FacetFilters = { ...EMPTY_FACETS, tag: ['еда', 'история', 'легенды'] };
    setup({ query: { filters, sort: DEFAULT_SORT } });
    expect(countActiveValues(filters)).toBe(3);
    expect(filtersButton()).toHaveAccessibleName('Фильтры 3');
    expect(filtersButton().className).toMatch(/is-active/);
  });

  it('the sort button carries the current value', () => {
    setup({ query: { filters: EMPTY_FACETS, sort: 'name' } });
    expect(screen.getByRole('button', { name: /Сортировка/ })).toHaveAccessibleName(
      'Сортировка: по названию',
    );
  });
});

describe('StoreToolbar — the filters draft (desktop)', () => {
  it('opens a dialog, recomputes N live and commits once', () => {
    const { onApply } = setup();
    fireEvent.click(filtersButton());
    const panel = screen.getByRole('dialog', { name: 'Фильтры' });
    expect(filtersButton()).toHaveAttribute('aria-expanded', 'true');
    expect(applyButton()).toHaveTextContent(
      'Показать 4 квеста',
    );

    fireEvent.click(chip('Белград'));
    expect(chip('Белград')).toHaveAttribute('aria-pressed', 'true');
    expect(applyButton()).toHaveTextContent(
      'Показать 2 квеста',
    );
    fireEvent.click(chip('Земун'));
    expect(applyButton()).toHaveTextContent(
      'Показать 3 квеста',
    );
    // Nothing is committed while the panel is being filled in.
    expect(onApply).not.toHaveBeenCalled();

    fireEvent.click(applyButton());
    expect(onApply).toHaveBeenCalledTimes(1);
    expect(onApply).toHaveBeenCalledWith({
      filters: { ...EMPTY_FACETS, city: ['Белград', 'Земун'] },
      sort: DEFAULT_SORT,
    });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('a chosen chip toggles off and touches nothing else in the facet', () => {
    const { onApply } = setup();
    fireEvent.click(filtersButton());
    fireEvent.click(chip('Белград'));
    fireEvent.click(chip('Земун'));
    fireEvent.click(chip('Белград'));
    fireEvent.click(applyButton());
    expect(onApply).toHaveBeenCalledWith({
      filters: { ...EMPTY_FACETS, city: ['Земун'] },
      sort: DEFAULT_SORT,
    });
  });

  it('Escape closes without committing and throws the draft away', () => {
    const { onApply } = setup();
    fireEvent.click(filtersButton());
    fireEvent.click(chip('Ниш'));
    fireEvent.keyDown(document, { key: 'Escape' });

    expect(screen.queryByRole('dialog')).toBeNull();
    expect(onApply).not.toHaveBeenCalled();
    expect(filtersButton()).toHaveFocus(); // focus returns to the trigger

    fireEvent.click(filtersButton());
    expect(chip('Ниш')).toHaveAttribute('aria-pressed', 'false');
  });

  it('an outside click closes without committing', () => {
    const { onApply } = setup();
    fireEvent.click(filtersButton());
    fireEvent.click(chip('Ниш'));
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(onApply).not.toHaveBeenCalled();
  });

  it('«Сбросить» is disabled with an empty draft and clears only the draft', () => {
    const { onApply } = setup({
      query: { filters: { ...EMPTY_FACETS, city: ['Ниш'] }, sort: DEFAULT_SORT },
    });
    fireEvent.click(filtersButton());
    const reset = resetButton();
    expect(reset).toBeEnabled(); // the draft opens on the applied state

    fireEvent.click(reset);
    expect(reset).toBeDisabled();
    expect(chip('Ниш')).toHaveAttribute('aria-pressed', 'false');
    expect(onApply).not.toHaveBeenCalled(); // reset alone commits nothing
    expect(applyButton()).toHaveTextContent('Показать 4 квеста');
  });

  it('the «Только не купленные» toggle appears only for a viewer with grants', () => {
    const { view } = setup({ showOwnedToggle: false });
    fireEvent.click(filtersButton());
    expect(screen.queryByRole('button', { name: /Только не купленные/ })).toBeNull();
    view.unmount();

    setup({ showOwnedToggle: true });
    fireEvent.click(filtersButton());
    const toggle = screen.getByRole('button', { name: /Только не купленные/ });
    expect(toggle).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(toggle);
    expect(screen.getByRole('button', { name: /Только не купленные/ })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });
});

describe('StoreToolbar — sorting (desktop)', () => {
  it('applies on click, keeps the filters and closes the popover', () => {
    const applied: FacetFilters = { ...EMPTY_FACETS, city: ['Ниш'] };
    const { onApply } = setup({ query: { filters: applied, sort: DEFAULT_SORT } });
    fireEvent.click(screen.getByRole('button', { name: /Сортировка/ }));
    const panel = screen.getByRole('dialog', { name: 'Сортировка' });
    fireEvent.click(within(panel).getByRole('button', { name: /По названию/ }));

    expect(onApply).toHaveBeenCalledWith({ filters: applied, sort: 'name' });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('only one popover is open at a time', () => {
    setup();
    fireEvent.click(filtersButton());
    fireEvent.click(screen.getByRole('button', { name: /Сортировка/ }));
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
    expect(screen.getByRole('dialog')).toHaveAccessibleName('Сортировка');
  });
});

describe('StoreToolbar — the mobile sheet', () => {
  beforeEach(() => setViewport(true));

  it('collapses to one button that opens a modal sheet with sorting first', () => {
    setup({ query: { filters: { ...EMPTY_FACETS, city: ['Ниш'] }, sort: DEFAULT_SORT } });
    expect(screen.queryByRole('button', { name: /Сортировка:/ })).toBeNull();
    const trigger = screen.getByRole('button', { name: 'Фильтры и сортировка 1' });

    fireEvent.click(trigger);
    const sheet = screen.getByRole('dialog', { name: 'Фильтры и сортировка' });
    expect(sheet).toHaveAttribute('aria-modal', 'true');
    const groups = within(sheet).getAllByRole('group');
    expect(groups[0]).toHaveAccessibleName('Сортировка');
  });

  it('commits sorting and filters together, in one apply', () => {
    const { onApply } = setup();
    fireEvent.click(screen.getByRole('button', { name: /Фильтры и сортировка/ }));
    fireEvent.click(chip('Земун'));
    fireEvent.click(screen.getByRole('button', { name: /По названию/ }));
    expect(onApply).not.toHaveBeenCalled(); // the sheet is one form

    fireEvent.click(applyButton());
    expect(onApply).toHaveBeenCalledTimes(1);
    expect(onApply).toHaveBeenCalledWith({
      filters: { ...EMPTY_FACETS, city: ['Земун'] },
      sort: 'name',
    });
  });

  it('renders outside the toolbar so nothing on the page can paint over it', () => {
    setup();
    fireEvent.click(screen.getByRole('button', { name: /Фильтры и сортировка/ }));
    const sheet = screen.getByRole('dialog');
    // The toolbar sits in the card grid with a z-index of its own; a sheet
    // nested in that stacking context loses to the fixed mobile tab bar.
    expect(document.querySelector('.stb')?.contains(sheet)).toBe(false);
    expect(sheet.closest('body')).toBe(document.body);
  });

  it('a click inside the sheet does not close it', () => {
    setup();
    fireEvent.click(screen.getByRole('button', { name: /Фильтры и сортировка/ }));
    fireEvent.mouseDown(screen.getByRole('dialog'));
    expect(screen.queryByRole('dialog')).not.toBeNull();
  });

  it('locks the page behind the sheet and unlocks it on close', () => {
    setup();
    fireEvent.click(screen.getByRole('button', { name: /Фильтры и сортировка/ }));
    expect(document.body.style.overflow).toBe('hidden');
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(document.body.style.overflow).toBe('');
  });

  it('traps focus and returns it to the trigger on close', () => {
    setup();
    const trigger = screen.getByRole('button', { name: /Фильтры и сортировка/ });
    fireEvent.click(trigger);
    const sheet = screen.getByRole('dialog');
    // «Сбросить» is disabled on an empty draft, so the tab ring is the enabled set.
    const focusables = Array.from(sheet.querySelectorAll<HTMLElement>('button:not([disabled])'));
    const first = focusables[0];
    const last = focusables[focusables.length - 1];

    expect(sheet.contains(document.activeElement)).toBe(true);
    last.focus();
    fireEvent.keyDown(last, { key: 'Tab' });
    expect(first).toHaveFocus();
    fireEvent.keyDown(first, { key: 'Tab', shiftKey: true });
    expect(last).toHaveFocus();

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(trigger).toHaveFocus();
  });
});
