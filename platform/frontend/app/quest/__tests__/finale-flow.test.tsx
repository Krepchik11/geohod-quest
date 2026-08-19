// @vitest-environment jsdom
/**
 * The finale, end to end through the REAL player (QuestPlayerClient):
 *
 *  - «в пути» is the recorded duration of the attempt, so reopening a finished
 *    quest shows the same number forever (issue #111);
 *  - the reward for the stars lands on the FIRST tap and the reward for the
 *    review lands when it is sent — each with the player's coin animation, and
 *    the «монет собрано» counter moves with it (issue #113);
 *  - both exits leave for the store; there is no «Продолжите путешествие»
 *    screen in between (issue #112).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Fact, QuestSnapshot } from '../../../lib/shared-model';

const push = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ push }) }));

vi.mock('../../../lib/identity', () => ({
  getDeviceId: () => 'dev-test',
  currentUserId: () => 'player-test',
}));

vi.mock('../../../lib/sync', () => ({ flushPending: vi.fn(async () => null) }));

vi.mock('../../../lib/api', () => ({ api: { listQuests: vi.fn(async () => []) } }));

vi.mock('../../../lib/client-features', () => ({
  useClientFeature: () => false,
  useUniversalAnswer: () => null,
}));

/** The REAL coin fold — the «монет собрано» tile is part of what is asserted. */
vi.mock('../../../lib/player-stats', async () => {
  const real = await vi.importActual<typeof import('../../../lib/player-stats')>('../../../lib/player-stats');
  return { foldLocalPlayerStats: real.foldLocalPlayerStats, gatherOtherAttemptLogs: vi.fn(async () => []) };
});

vi.mock('../sound', () => ({ coinChime: vi.fn(), spendChime: vi.fn() }));

const appended: Fact[] = [];
const STARTED_AT = '2020-05-01T10:00:00.000Z';
const FINISHED_AT = '2020-05-01T11:24:00.000Z';

vi.mock('../../../lib/queue', async () => {
  const real = await vi.importActual<typeof import('../../../lib/queue')>('../../../lib/queue');
  return {
    factNaturalKey: real.factNaturalKey,
    ensureActiveAttempt: vi.fn(async () => ({ attempt_key: 'att-1' })),
    getFacts: vi.fn(async () => []),
    listAttempts: vi.fn(async () => []),
    setLastStepIdx: vi.fn(async () => {}),
    migrateLegacyLocalStorage: vi.fn(async () => {}),
    appendFact: vi.fn(async (_key: string, fact: Fact) => {
      appended.push(fact);
    }),
    openAttempt: vi.fn(async () => ({
      attempt: { attempt_key: 'att-1', created_at: STARTED_AT, last_step_idx: 1 },
      facts: COMPLETED_LOG,
      queueStatus: {},
      showStartGate: false,
      completedAt: FINISHED_AT,
    })),
  };
});

import QuestPlayerClient from '../QuestPlayerClient';

const SNAPSHOT: QuestSnapshot = {
  golden_id: 'q-final',
  name: 'Тестовый квест',
  snapshot_version: 1,
  steps: [
    {
      position: 0,
      template: 'start',
      rich_content: { title: 'Тестовый квест', main_text: 'Поехали' },
      media: {},
      completion: { mode: 'physical' },
      supporting: { is_start: true },
    },
    {
      position: 1,
      template: 'congrats',
      rich_content: { title: 'Квест пройден!', main_text: 'Готово' },
      media: {},
      completion: { mode: 'physical' },
      supporting: { terminal: true },
    },
  ],
};

/** A finished attempt as it comes back from the queue on a reopen. */
const COMPLETED_LOG: Fact[] = [
  {
    type: 'attempt_completed',
    step_position: 1,
    submitted_value: null,
    local_is_correct: true,
    coins_delta: 0,
    note: 'Квест пройден',
    device_id: 'dev-test',
  },
  {
    type: 'completion_bonus',
    step_position: 1,
    submitted_value: null,
    local_is_correct: true,
    coins_delta: 5,
    note: 'Бонус за прохождение',
    device_id: 'dev-test',
  },
];

async function openFinale() {
  render(<QuestPlayerClient snapshot={SNAPSHOT} questId="q-final" snapshotId="snap-1" />);
  await screen.findByText('ПОЗДРАВЛЯЕМ ВЫ ПРОШЛИ КВЕСТ');
  return userEvent.setup();
}

const stat = (label: string) =>
  Array.from(document.querySelectorAll('.p-stat')).find((n) => n.textContent?.includes(label))!;

beforeEach(() => {
  appended.length = 0;
  push.mockClear();
});

describe('the finale reports the attempt, not the clock (#111)', () => {
  it('shows the recorded start→finish duration, unchanged by anything that happens after', async () => {
    const user = await openFinale();
    expect(stat('в пути').textContent).toContain('1:24');
    // Any re-render used to re-read the clock; the recorded duration cannot move.
    await user.click(screen.getByRole('button', { name: '5 звёзд' }));
    expect(stat('в пути').textContent).toContain('1:24');
  });
});

describe('the finale pays the review as it happens (#113)', () => {
  it('pays the stars on the FIRST tap — coin toast and the counter move together', async () => {
    const user = await openFinale();
    expect(stat('монет собрано').textContent).toContain('5');

    await user.click(screen.getByRole('button', { name: '4 звёзд' }));

    expect(await screen.findByText('+5 монет')).toBeTruthy();
    expect(screen.getByText('За оценку')).toBeTruthy();
    expect(appended.some((f) => f.type === 'quest_rated' && f.submitted_value === '4')).toBe(true);
    expect(appended.some((f) => f.type === 'rating_bonus' && f.coins_delta === 5)).toBe(true);
    expect(stat('монет собрано').textContent).toContain('10');
  });

  it('pays the stars once — changing them later neither re-pays nor re-animates', async () => {
    const user = await openFinale();
    await user.click(screen.getByRole('button', { name: '4 звёзд' }));
    await waitFor(() => expect(document.querySelector('.p-toast')).toBeNull(), { timeout: 3000 });

    await user.click(screen.getByRole('button', { name: '5 звёзд' }));
    expect(document.querySelector('.p-toast')).toBeNull();
    expect(appended.filter((f) => f.type === 'rating_bonus')).toHaveLength(1);
    expect(stat('монет собрано').textContent).toContain('10');
  });

  it('pays the review when it is sent, and lets the animation finish before leaving', async () => {
    const user = await openFinale();
    await user.click(screen.getByRole('button', { name: '5 звёзд' }));
    await user.type(screen.getByPlaceholderText('Пара слов для будущих игроков?'), 'Отличный маршрут');
    await user.click(screen.getByRole('button', { name: /ОТПРАВИТЬ ОЦЕНКУ/ }));

    expect(await screen.findByText('За отзыв')).toBeTruthy();
    expect(appended.some((f) => f.type === 'comment_bonus' && f.coins_delta === 5)).toBe(true);
    expect(appended.some((f) => f.type === 'quest_rated' && f.note === 'Отличный маршрут')).toBe(true);
    // the animation is still on screen — the player has not been sent away yet
    expect(push).not.toHaveBeenCalled();
    await waitFor(() => expect(push).toHaveBeenCalledWith('/#shop'), { timeout: 3000 });
  });
});

describe('the finale exits to the store (#112)', () => {
  it('«Пропустить оценку» leaves for the store at once, with nothing in between', async () => {
    const user = await openFinale();
    await user.click(screen.getByRole('button', { name: 'Пропустить оценку' }));
    expect(push).toHaveBeenCalledWith('/#shop');
    expect(screen.queryByText('Продолжите путешествие')).toBeNull();
  });

  it('«Отправить без отзыва» leaves for the store too', async () => {
    const user = await openFinale();
    await user.click(screen.getByRole('button', { name: '5 звёзд' }));
    await user.click(screen.getByRole('button', { name: 'Отправить без отзыва' }));
    await waitFor(() => expect(push).toHaveBeenCalledWith('/#shop'), { timeout: 3000 });
    expect(screen.queryByText('Продолжите путешествие')).toBeNull();
  });
});
