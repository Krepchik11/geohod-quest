// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import React from 'react';

/**
 * The store page (§2.1): the URL is the source of truth on mount, the toolbar
 * is only a draft over it, and «Показать N квестов» promises exactly the number
 * of cards that appear. One apply = one history entry.
 */
const { listQuestsMock, listGrantsMock } = vi.hoisted(() => ({
  listQuestsMock: vi.fn(),
  listGrantsMock: vi.fn(),
}));

vi.mock('../../lib/api', () => ({
  api: {
    listQuests: listQuestsMock,
    listGrants: listGrantsMock,
    me: vi.fn(async () => ({ role: 'player', display_name: null })),
    checkout: vi.fn(),
    getBundle: vi.fn(),
    paymentProviders: vi.fn(async () => ({ providers: ['mock'] })),
  },
  ApiError: class extends Error { status = 0; },
  hasAdminToken: () => false,
}));
vi.mock('../../lib/identity', () => ({
  currentUserId: () => 'dev:test',
  getSession: () => null,
  subscribeSession: () => () => {},
}));
vi.mock('../../lib/download', () => ({ downloadBundle: vi.fn(async () => {}) }));

import GeoQuestHome from '../page';
import type { PublishedQuestWire } from '../../lib/api';

function quest(over: Partial<PublishedQuestWire>): PublishedQuestWire {
  return {
    quest_id: 'q', name: 'Квест', primary_comic: null, template_summary: '', description: null, pages: null, tasks: null, paid_hints: null,
    snapshot_version: 1, snapshot_id: 's', city: 'Белград', duration: '2 часа',
    price: 890, rating_avg: 4.5, rating_count: 10, players: 100,
    complexity: 'medium', age_target: 'everyone', tags: ['история'],
    ...over,
  };
}

const CATALOG = [
  quest({ quest_id: 'a', name: 'Ад Калемегдана', city: 'Белград', rating_avg: 4.8, rating_count: 32, tags: ['история'] }),
  quest({ quest_id: 'b', name: 'Ярость Земуна', city: 'Земун', rating_avg: 4.9, rating_count: 5, price: 0, tags: ['еда'] }),
  quest({ quest_id: 'c', name: 'Шифры Ниша', city: 'Ниш', rating_avg: 0, rating_count: 0, tags: ['история'] }),
];

const cards = () => Array.from(document.querySelectorAll('.quest-card'));
const cardNames = () => cards().map((c) => c.querySelector('.quest-card__title')?.textContent);
const filtersButton = () => screen.getByRole('button', { name: /^Фильтры/ });
const applyButton = () => screen.getByRole('button', { name: /Показать/ });
/** The browser percent-encodes what we wrote as readable Cyrillic. */
const search = () => decodeURIComponent(window.location.search);

async function mountStore() {
  const view = render(<GeoQuestHome />);
  await screen.findByRole('button', { name: /^Фильтры/ });
  return view;
}

beforeEach(() => {
  listQuestsMock.mockResolvedValue(CATALOG);
  listGrantsMock.mockResolvedValue([]);
  window.history.replaceState(null, '', '/');
});

describe('the store page and the URL', () => {
  it('applies the URL on mount — a shared link opens the same shelf', async () => {
    window.history.replaceState(null, '', '/?city=Земун');
    await mountStore();
    await waitFor(() => expect(cardNames()).toEqual(['Ярость Земуна']));
    expect(filtersButton()).toHaveAccessibleName('Фильтры 1');
  });

  it('sorts by rating by default: unrated last, ties broken by rating_count', async () => {
    await mountStore();
    await waitFor(() => expect(cards()).toHaveLength(3));
    expect(cardNames()).toEqual(['Ярость Земуна', 'Ад Калемегдана', 'Шифры Ниша']);
  });

  it('«Показать N квестов» is the number of cards that appear, in one history entry', async () => {
    await mountStore();
    await waitFor(() => expect(cards()).toHaveLength(3));
    const before = window.history.length;

    fireEvent.click(filtersButton());
    fireEvent.click(screen.getByRole('button', { name: 'Белград' }));
    fireEvent.click(screen.getByRole('button', { name: 'Ниш' }));
    const apply = applyButton();
    expect(apply).toHaveTextContent('Показать 2 квеста');
    fireEvent.click(apply);

    expect(cards()).toHaveLength(2);
    expect(cardNames()).toEqual(['Ад Калемегдана', 'Шифры Ниша']);
    expect(search()).toBe('?city=Белград,Ниш');
    expect(window.history.length).toBe(before + 1);
  });

  it('re-applying the same filters adds no history entry', async () => {
    await mountStore();
    await waitFor(() => expect(cards()).toHaveLength(3));
    fireEvent.click(filtersButton());
    fireEvent.click(screen.getByRole('button', { name: 'Земун' }));
    fireEvent.click(applyButton());
    const after = window.history.length;

    fireEvent.click(filtersButton());
    fireEvent.click(applyButton());
    expect(window.history.length).toBe(after);
  });

  it('keeps «Только не купленные» reachable when the URL carries it', async () => {
    window.history.replaceState(null, '', '/?owned=0');
    await mountStore();
    fireEvent.click(filtersButton());
    // No grants (the list load may even have failed) — but a filter that is ON
    // must stay switchable off, or «Сбросить» is the only way out of it.
    expect(screen.getByRole('button', { name: /Только не купленные/ })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  it('sorting by name writes the sort key and reorders the cards', async () => {
    await mountStore();
    await waitFor(() => expect(cards()).toHaveLength(3));
    fireEvent.click(screen.getByRole('button', { name: /Сортировка/ }));
    fireEvent.click(screen.getByRole('button', { name: /По названию/ }));

    expect(cardNames()).toEqual(['Ад Калемегдана', 'Шифры Ниша', 'Ярость Земуна']);
    expect(search()).toBe('?sort=name');
  });

  it('drops a value the catalog no longer has, without a new history entry', async () => {
    window.history.replaceState(null, '', '/?city=Белград&tag=ретро');
    await mountStore();
    const before = window.history.length;
    await waitFor(() => expect(search()).toBe('?city=Белград'));
    expect(cardNames()).toEqual(['Ад Калемегдана']);
    expect(window.history.length).toBe(before);
  });

  it('going back restores the previous shelf', async () => {
    await mountStore();
    await waitFor(() => expect(cards()).toHaveLength(3));
    fireEvent.click(filtersButton());
    fireEvent.click(screen.getByRole('button', { name: 'Земун' }));
    fireEvent.click(applyButton());
    expect(cards()).toHaveLength(1);

    act(() => {
      window.history.replaceState(null, '', '/');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    await waitFor(() => expect(cards()).toHaveLength(3));
  });

  it('an empty result offers the only way out — «Сбросить фильтры»', async () => {
    window.history.replaceState(null, '', '/?age=kids,18plus&complexity=low');
    await mountStore();
    await waitFor(() => expect(cards()).toHaveLength(0));
    fireEvent.click(screen.getByRole('button', { name: 'Сбросить фильтры' }));
    await waitFor(() => expect(cards()).toHaveLength(3));
    expect(search()).toBe('');
  });

  it('offers «Только не купленные» only to a viewer who owns something', async () => {
    const { unmount } = await mountStore();
    fireEvent.click(filtersButton());
    expect(screen.queryByRole('button', { name: /Только не купленные/ })).toBeNull();
    unmount();

    listGrantsMock.mockResolvedValue([{ user_id: 'dev:test', quest_id: 'a' }]);
    await mountStore();
    await waitFor(() => expect(cards()).toHaveLength(3));
    fireEvent.click(filtersButton());
    const toggle = await screen.findByRole('button', { name: /Только не купленные/ });
    fireEvent.click(toggle);
    fireEvent.click(applyButton());
    expect(cardNames()).toEqual(['Ярость Земуна', 'Шифры Ниша']);
    expect(search()).toBe('?owned=0');
  });

  it('no free-text search survives on the store page', async () => {
    await mountStore();
    expect(document.querySelector('#qf-search')).toBeNull();
  });
});
