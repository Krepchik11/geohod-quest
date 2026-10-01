// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { resetCollectionForTests } from '../../lib/collection';
import '@testing-library/jest-dom/vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import React from 'react';

/**
 * The store page (§2.1): the URL is the source of truth on mount, the toolbar
 * is only a draft over it, and «Показать N квестов» promises exactly the number
 * of cards that appear. One apply = one history entry.
 */
const { listQuestsMock, listGrantsMock, mineFlag, citiesFlag, ownedStatusMock, inProgressMock, shelfMock } = vi.hoisted(() => ({
  listQuestsMock: vi.fn(),
  listGrantsMock: vi.fn(),
  mineFlag: { on: false },
  citiesFlag: { on: false, soon: [] as string[] },
  ownedStatusMock: vi.fn(),
  inProgressMock: vi.fn(),
  shelfMock: vi.fn(),
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
vi.mock('../../lib/client-features', () => ({
  useClientFeature: () => false,
  useRememberedClientFeature: (key: string) =>
    (key === 'store_my_quests' && mineFlag.on) || (key === 'store_cities' && citiesFlag.on),
  useUniversalAnswer: () => null,
  useSoonCities: () => citiesFlag.soon,
}));
// The device's view of own quests is lib/owned-quests' (tested there); the
// page's job is the order, the hero and the offline fallback.
vi.mock('../../lib/owned-quests', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/owned-quests')>()),
  ownedStatus: ownedStatusMock,
  latestInProgress: inProgressMock,
}));
vi.mock('../../lib/offline-shelf', () => ({
  loadOfflineShelf: shelfMock,
  rememberCatalog: vi.fn(),
  rememberGrants: vi.fn(),
}));

import GeoQuestHome from '../page';
import type { PublishedQuestWire } from '../../lib/api';
import { FRESH_STATUS } from '../../lib/owned-quests';

function quest(over: Partial<PublishedQuestWire>): PublishedQuestWire {
  return {
    quest_id: 'q', name: 'Квест', primary_comic: null, template_summary: '', description: null, pages: null, tasks: null, paid_hints: null,
    snapshot_version: 1, snapshot_id: 's', city: 'Белград', duration: '2 часа', duration_min: 60, distance_km: 5,
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
  resetCollectionForTests();
  listQuestsMock.mockResolvedValue(CATALOG);
  listGrantsMock.mockResolvedValue([]);
  window.history.replaceState(null, '', '/');
  window.localStorage.clear();
  mineFlag.on = false;
  citiesFlag.on = false;
  citiesFlag.soon = [];
  ownedStatusMock.mockResolvedValue(FRESH_STATUS);
  inProgressMock.mockResolvedValue(null);
  shelfMock.mockReset();
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

    // The collection is cached per identity — drop it so the second mount refetches.
    resetCollectionForTests();
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

describe('store_my_quests: the shop is the player\'s own shelf', () => {
  const grant = (quest_id: string, granted_at: string) => ({
    user_id: 'dev:test', quest_id, granted_at, source: 'free', source_ref: null,
  });

  beforeEach(() => {
    mineFlag.on = true;
    listGrantsMock.mockResolvedValue([grant('c', '2026-09-01T00:00:00Z'), grant('a', '2026-09-10T00:00:00Z')]);
  });

  it('own quests lead — the one in progress before the unstarted — then the rest by the sort', async () => {
    ownedStatusMock.mockImplementation(async (id: string) =>
      id === 'c'
        ? { ...FRESH_STATUS, state: 'progress', pos: 2, total: 5, lastActivity: '2026-09-30T00:00:00Z' }
        : FRESH_STATUS,
    );
    await mountStore();
    await waitFor(() => expect(cardNames()).toEqual(['Шифры Ниша', 'Ад Калемегдана', 'Ярость Земуна']));
    expect(screen.getByText('шаг 2 из 5')).toBeInTheDocument();
    expect(ownedStatusMock).toHaveBeenCalledWith('c', 's'); // the published version, for «Обновить»
  });

  it('filters apply to own quests like to any card', async () => {
    window.history.replaceState(null, '', '/?city=Земун');
    await mountStore();
    await waitFor(() => expect(cardNames()).toEqual(['Ярость Земуна']));
  });

  it('the hero goes straight back into the quest in progress', async () => {
    inProgressMock.mockResolvedValue({ questId: 'c', name: 'Шифры Ниша', downloaded: true });
    await mountStore();
    expect(await screen.findByRole('link', { name: 'Продолжить «Шифры Ниша»' })).toHaveAttribute('href', '/quest/c');
  });

  it('with own quests and none running, the hero points down at them', async () => {
    await mountStore();
    await waitFor(() => expect(screen.getByRole('link', { name: 'Мои квесты' })).toHaveAttribute('href', '#shop'));
  });

  it('offline: only own quests from the device, under a note; nothing to buy', async () => {
    listQuestsMock.mockRejectedValue(new Error('offline'));
    shelfMock.mockResolvedValue({ quests: [CATALOG[0]], owned: new Set(['a']), grantedAt: new Map() });
    // One quest on the device: no filters to offer (ТЗ, задача 17), only the sort.
    // The note shows while the shelf's own quests still settle, so wait for the
    // card itself — not for the note — before reading the grid.
    render(<GeoQuestHome />);
    await waitFor(() => expect(cardNames()).toEqual(['Ад Калемегдана']));
    expect(screen.getByText(/^Нет сети\. Ниже — ваши квесты на этом устройстве/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Купить' })).toBeNull();
    expect(ownedStatusMock).toHaveBeenCalledWith('a', null); // the published version is unknown offline
  });

  it('offline with nothing on the device says so instead of an error', async () => {
    listQuestsMock.mockRejectedValue(new Error('offline'));
    shelfMock.mockResolvedValue({ quests: [], owned: new Set(), grantedAt: new Map() });
    render(<GeoQuestHome />);
    expect(await screen.findByText('На этом устройстве нет ваших квестов.')).toBeInTheDocument();
    expect(screen.queryByText(/Не удалось загрузить магазин/)).toBeNull();
  });

  it('with the flag off a failed catalog is still the plain error', async () => {
    mineFlag.on = false;
    listQuestsMock.mockRejectedValue(new Error('offline'));
    render(<GeoQuestHome />);
    expect(await screen.findByText(/Не удалось загрузить магазин/)).toBeInTheDocument();
    expect(shelfMock).not.toHaveBeenCalled();
  });
});

describe('store_cities: one city at a time (ТЗ, задачи 14–17)', () => {
  it('opens on the busiest city, names it in the hero and offers only the sort for a few quests', async () => {
    citiesFlag.on = true;
    listQuestsMock.mockResolvedValue([
      ...CATALOG,
      quest({ quest_id: 'd', name: 'Тайны Земуна', city: 'Земун', rating_avg: 4, rating_count: 1 }),
    ]);
    render(<GeoQuestHome />);
    await waitFor(() => expect(cardNames()).toEqual(['Ярость Земуна', 'Тайны Земуна']));
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Земун, о котором не расскажет экскурсовод');
    expect(screen.getByRole('button', { name: 'Земун' })).toHaveAttribute('aria-pressed', 'true');
    // Two quests in the city: no filters, only the sort (and no city facet anyway).
    expect(screen.queryByRole('button', { name: /^Фильтры/ })).toBeNull();
    expect(screen.getByRole('button', { name: /^Сортировка/ })).toBeTruthy();
  });

  it('a picked city filters the shop, lands in the URL and is remembered', async () => {
    citiesFlag.on = true;
    render(<GeoQuestHome />);
    await waitFor(() => expect(cards()).toHaveLength(1));
    fireEvent.click(screen.getByRole('button', { name: 'Белград' }));
    expect(cardNames()).toEqual(['Ад Калемегдана']);
    expect(search()).toBe('?city=Белград');
    expect(window.localStorage.getItem('geohod-city:v1')).toBe('Белград');
  });

  it('announces the «скоро» cities with a chip and a block that leads to the channel', async () => {
    citiesFlag.on = true;
    citiesFlag.soon = ['Белград', 'Стамбул'];
    render(<GeoQuestHome />);
    await waitFor(() => expect(cards()).toHaveLength(1));
    // Белград already has quests — only Стамбул is «скоро».
    expect(screen.getByRole('link', { name: /Стамбул\s*скоро/ })).toHaveAttribute('href', '#soon');
    expect(screen.getByRole('heading', { name: 'Скоро в новых городах' })).toBeTruthy();
    expect(screen.getByRole('link', { name: /Узнать о запуске/ })).toHaveAttribute('href', 'https://t.me/serbia_progulki');
  });

  it('without the flag there are no chips and no «скоро», while «Вместе веселее» stays', async () => {
    citiesFlag.soon = ['Стамбул'];
    await mountStore();
    expect(screen.queryByRole('group', { name: 'Город' })).toBeNull();
    expect(screen.queryByText('Скоро в новых городах')).toBeNull();
    expect(screen.getByRole('heading', { name: 'Вместе веселее' })).toBeTruthy();
  });
});
