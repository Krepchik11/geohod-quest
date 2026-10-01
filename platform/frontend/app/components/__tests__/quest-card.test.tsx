// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import React from 'react';

/**
 * §2.1/§2.2 shop card v2:
 * - the WHOLE card is one block link to /quest/[id]/about (the title anchor
 *   stretches over the card); the separate «О квесте и отзывы →» link is gone;
 *   NOTHING on the card routes to the player anymore (owned CTA excepted);
 * - paid «Купить» opens the confirmation sheet (fast-path);
 * - free «Получить» grants instantly, success state lives IN the card;
 * - pending/error status lives in the card, never under the grid.
 */
const { checkoutMock, downloadMock, removeBlockMock, removeMock, shareFlag } = vi.hoisted(() => ({
  checkoutMock: vi.fn(),
  downloadMock: vi.fn(async () => ({})),
  removeBlockMock: vi.fn(async (): Promise<'in-progress' | null> => null),
  removeMock: vi.fn(async () => {}),
  shareFlag: { on: false },
}));
vi.mock('../../../lib/api', () => ({
  api: {
    checkout: checkoutMock,
    getBundle: vi.fn(),
    paymentProviders: vi.fn().mockResolvedValue({ providers: ['mock'] }),
  },
}));
vi.mock('../../../lib/identity', () => ({
  currentUserId: () => 'dev:test',
  getSession: () => null,
  subscribeSession: () => () => {},
}));
vi.mock('../../../lib/download', () => ({
  downloadBundle: downloadMock,
  removeBlock: removeBlockMock,
  removeDownloadedQuest: removeMock,
}));
vi.mock('../../../lib/client-features', () => ({
  useClientFeature: (key: string) => (key === 'quest_share' ? shareFlag.on : false),
  useUniversalAnswer: () => null,
}));

import QuestCard, { type MineProps } from '../QuestCard';
import type { PublishedQuestWire } from '../../../lib/api';
import { FRESH_STATUS, type OwnedStatus } from '../../../lib/owned-quests';
import type { BundleRow } from '../../../lib/queue';

function quest(over: Partial<PublishedQuestWire>): PublishedQuestWire {
  return {
    quest_id: 'q1', name: 'Тайны старого Белграда', primary_comic: null,
    template_summary: '', description: null, pages: null, tasks: null, paid_hints: null, snapshot_version: 1, snapshot_id: 's1',
    city: 'Белград', duration: '2–3 часа', duration_min: 60, distance_km: 5, price: 890,
    rating_avg: 4.8, rating_count: 24, players: 0,
    complexity: null, age_target: null, tags: [], ...over,
  };
}

beforeEach(() => {
  shareFlag.on = false;
  checkoutMock.mockReset();
  downloadMock.mockClear();
});

/* §share: the card carries the icon variant, gated by quest_share. */
describe('QuestCard — «Поделиться»', () => {
  const name = 'Поделиться квестом';

  it('is absent while the flag is off', () => {
    render(<QuestCard quest={quest({})} owned={false} />);
    expect(screen.queryByRole('button', { name })).toBeNull();
  });

  it('is offered on a card the visitor has NOT bought', () => {
    shareFlag.on = true;
    render(<QuestCard quest={quest({})} owned={false} />);
    expect(screen.getByRole('button', { name })).toBeTruthy();
  });

  it('is offered on an owned card too', () => {
    shareFlag.on = true;
    render(<QuestCard quest={quest({})} owned />);
    expect(screen.getByRole('button', { name })).toBeTruthy();
  });
});

describe('QuestCard', () => {
  it('the whole card is one link to the product page; the old «О квесте» link is gone', () => {
    render(<QuestCard quest={quest({})} owned={false} />);
    // Unowned card: the only link is the stretched title anchor → product page.
    // (The CTA is a <button>, not a link.) Nothing routes to the player.
    const links = screen.getAllByRole('link');
    expect(links).toHaveLength(1);
    expect(links[0].getAttribute('href')).toBe('/quest/q1/about');
    expect(screen.getByRole('link').textContent).toContain('Тайны старого Белграда');
    expect(screen.queryByText('О квесте и отзывы →')).toBeNull();
  });

  it('shows the players counter (real + marketing bonus) only when positive', () => {
    const { rerender } = render(<QuestCard quest={quest({ players: 0 })} owned={false} />);
    expect(screen.queryByText(/игрок/)).toBeNull();
    rerender(<QuestCard quest={quest({ players: 1240 })} owned={false} />);
    expect(screen.getByText(/1240\s+игроков/)).toBeTruthy();
  });

  it('hides a players counter that would contradict the ratings (ТЗ, задача 3)', () => {
    // 24 ratings imported without completions: «1 игрок» next to them reads as a fake.
    render(<QuestCard quest={quest({ players: 1, rating_count: 24 })} owned={false} />);
    expect(screen.queryByText(/игрок/)).toBeNull();
    expect(screen.getByText(/24\s+оценки/)).toBeTruthy();
  });

  it('paid quest: «Купить» opens the confirmation sheet, no instant charge', () => {
    render(<QuestCard quest={quest({})} owned={false} />);
    fireEvent.click(screen.getByRole('button', { name: 'Купить' }));
    expect(screen.getByText('Подтвердите покупку')).toBeTruthy();
    expect(checkoutMock).not.toHaveBeenCalled();
  });

  it('free quest: «Получить» grants instantly and flips the card in place', async () => {
    checkoutMock.mockResolvedValue({});
    render(<QuestCard quest={quest({ price: 0 })} owned={false} />);
    fireEvent.click(screen.getByRole('button', { name: 'Получить' }));
    await waitFor(() => expect(screen.getByText('✓ Квест в «Моих квестах»')).toBeTruthy());
    expect(screen.getByRole('link', { name: 'Играть' }).getAttribute('href')).toBe('/quest/q1');
    expect(checkoutMock).toHaveBeenCalledWith({ user_id: 'dev:test', quest_id: 'q1' });
  });

  it('free-grant failure shows the red line in the card', async () => {
    checkoutMock.mockRejectedValue(new Error('net'));
    render(<QuestCard quest={quest({ price: 0 })} owned={false} />);
    fireEvent.click(screen.getByRole('button', { name: 'Получить' }));
    await waitFor(() =>
      expect(screen.getByText('Не получилось оформить покупку — попробуйте ещё раз.')).toBeTruthy(),
    );
  });

  it('owned quest shows the badge and «Играть» to the player', () => {
    render(<QuestCard quest={quest({})} owned />);
    expect(screen.getByText('✓ Куплен')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Играть' }).getAttribute('href')).toBe('/quest/q1');
  });

  it('purchase via the sheet flips the card and auto-downloads silently (§3.4)', async () => {
    checkoutMock.mockResolvedValue({});
    render(<QuestCard quest={quest({})} owned={false} />);
    fireEvent.click(screen.getByRole('button', { name: 'Купить' }));
    fireEvent.click(screen.getByRole('button', { name: 'Подтвердить — 890 ₽' }));
    await waitFor(() => expect(screen.getByText('✓ Квест в «Моих квестах»')).toBeTruthy());
    expect(downloadMock).toHaveBeenCalled();
  });
});

/* store_my_quests: an owned card is the player's own quest — state, progress,
   the one honest CTA and ONE offline chip that downloads, updates, completes a
   partial download or opens «Удалить с устройства». */
describe('QuestCard — own quest (store_my_quests)', () => {
  const downloaded = (over: Partial<BundleRow> = {}): BundleRow => ({
    snapshot_id: 's1', quest_id: 'q1', version: 1, size_bytes: 1, downloaded_at: '2026-09-01T00:00:00Z',
    snapshot: {} as BundleRow['snapshot'], media_complete: true, ...over,
  });
  const mine = (status: Partial<OwnedStatus> | null, over: Partial<MineProps> = {}): MineProps => ({
    status: status && { ...FRESH_STATUS, ...status },
    offline: false,
    onChange: vi.fn(),
    ...over,
  });
  const ready = 'Скачан для офлайна. Удалить с устройства';

  beforeEach(() => {
    removeBlockMock.mockClear();
    removeMock.mockClear();
  });

  it('not started: the badge, «Куплен», «Начать» into the player', () => {
    render(<QuestCard quest={quest({})} owned mine={mine({})} />);
    expect(screen.getByText('Не начат')).toBeTruthy();
    expect(screen.getByText('Куплен')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Начать' }).getAttribute('href')).toBe('/quest/q1');
  });

  it('in progress: the step in the price slot and «Продолжить»', () => {
    render(<QuestCard quest={quest({})} owned mine={mine({ state: 'progress', pos: 3, total: 12 })} />);
    expect(screen.getByText('В процессе')).toBeTruthy();
    expect(screen.getByText('шаг 3 из 12')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Продолжить' }).getAttribute('href')).toBe('/quest/q1');
  });

  it('done: the finish date, and «Пройти заново» restarts', () => {
    render(<QuestCard quest={quest({})} owned mine={mine({ state: 'done', lastActivity: '2026-09-28T12:00:00Z' })} />);
    expect(screen.getByText('пройден 28.09.2026')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Пройти заново' }).getAttribute('href')).toBe('/quest/q1?restart=1');
  });

  it('«⭳ Скачать» downloads on the card, then re-reads the status', async () => {
    const m = mine({});
    render(<QuestCard quest={quest({})} owned mine={m} />);
    fireEvent.click(screen.getByRole('button', { name: 'Скачать для офлайна' }));
    await waitFor(() => expect(m.onChange).toHaveBeenCalledWith('q1'));
    expect(downloadMock).toHaveBeenCalledWith('q1', 'dev:test', expect.anything(), expect.any(Function));
  });

  it('an update, and a partial download, are offered for re-download', () => {
    const { rerender } = render(
      <QuestCard quest={quest({})} owned mine={mine({ bundle: downloaded(), updateAvailable: true })} />,
    );
    expect(screen.getByRole('button', { name: 'Обновить' })).toBeTruthy();
    rerender(<QuestCard quest={quest({})} owned mine={mine({ bundle: downloaded({ media_complete: false }) })} />);
    expect(screen.getByRole('button', { name: '⭳ Докачать' })).toBeTruthy();
  });

  it('«⭳ офлайн» opens «Удалить с устройства»; confirming removes and re-reads', async () => {
    const m = mine({ bundle: downloaded() });
    render(<QuestCard quest={quest({})} owned mine={m} />);
    fireEvent.click(screen.getByRole('button', { name: ready }));
    const dialog = await screen.findByRole('dialog', { name: 'Удалить с устройства' });
    const remove = within(dialog).getByRole('button', { name: 'Удалить' }) as HTMLButtonElement;
    await waitFor(() => expect(remove.disabled).toBe(false));
    fireEvent.click(remove);
    await waitFor(() => expect(removeMock).toHaveBeenCalledWith('q1'));
    await waitFor(() => expect(m.onChange).toHaveBeenCalledWith('q1'));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('a quest in progress cannot be removed — the sheet says why', async () => {
    removeBlockMock.mockResolvedValueOnce('in-progress');
    render(<QuestCard quest={quest({})} owned mine={mine({ state: 'progress', pos: 2, total: 5, bundle: downloaded() })} />);
    fireEvent.click(screen.getByRole('button', { name: ready }));
    expect(await screen.findByText('Квест уже начат')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Удалить' })).toBeNull();
    expect(removeMock).not.toHaveBeenCalled();
  });

  it('offline: a downloaded quest plays; one not downloaded needs the network', () => {
    const { rerender } = render(
      <QuestCard quest={quest({})} owned mine={mine({ bundle: downloaded() }, { offline: true })} />,
    );
    expect(screen.getByRole('link', { name: 'Начать' }).getAttribute('href')).toBe('/quest/q1');
    rerender(<QuestCard quest={quest({})} owned mine={mine({}, { offline: true })} />);
    expect((screen.getByRole('button', { name: 'Нужна сеть' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByRole('button', { name: 'Скачать для офлайна' })).toBeNull();
  });

  it('a free grant flips the card to the own quest and downloads visibly', async () => {
    checkoutMock.mockResolvedValue({});
    const m = mine(null);
    render(<QuestCard quest={quest({ price: 0 })} owned={false} mine={m} />);
    fireEvent.click(screen.getByRole('button', { name: 'Получить' }));
    await waitFor(() => expect(screen.getByText('✓ Квест ваш')).toBeTruthy());
    await waitFor(() => expect(m.onChange).toHaveBeenCalledWith('q1'));
  });
});
