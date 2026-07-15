// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
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
const { checkoutMock, downloadMock } = vi.hoisted(() => ({
  checkoutMock: vi.fn(),
  downloadMock: vi.fn(async () => ({})),
}));
vi.mock('../../../lib/api', () => ({
  api: {
    checkout: checkoutMock,
    getBundle: vi.fn(),
    paymentProviders: vi.fn().mockResolvedValue({ providers: ['mock'] }),
  },
}));
vi.mock('../../../lib/identity', () => ({
  currentPlayerId: () => 'dev:test',
  getSession: () => null,
  subscribeSession: () => () => {},
}));
vi.mock('../../../lib/download', () => ({ downloadBundle: downloadMock }));

import QuestCard from '../QuestCard';
import type { PublishedQuestWire } from '../../../lib/api';

function quest(over: Partial<PublishedQuestWire>): PublishedQuestWire {
  return {
    quest_id: 'q1', name: 'Тайны старого Белграда', primary_comic: null,
    template_summary: '', snapshot_version: 1, snapshot_id: 's1',
    city: 'Белград', duration: '2–3 часа', price: 890,
    rating_avg: 4.8, rating_count: 24, players: 0, ...over,
  };
}

beforeEach(() => {
  checkoutMock.mockReset();
  downloadMock.mockClear();
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
    expect(screen.queryByText(/сыграл/)).toBeNull();
    rerender(<QuestCard quest={quest({ players: 1240 })} owned={false} />);
    expect(screen.getByText(/1240\s+игроков сыграли/)).toBeTruthy();
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
    expect(checkoutMock).toHaveBeenCalledWith({ player_id: 'dev:test', quest_id: 'q1' });
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
