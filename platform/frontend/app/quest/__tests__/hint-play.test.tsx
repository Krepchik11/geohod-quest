// @vitest-environment jsdom
/**
 * Play-time hint flow, end to end through the REAL player (QuestPlayerClient):
 * the paper chip and the post-2nd-wrong popup both sell the hint, the purchase
 * opens the reveal popup, and the inline hint box keeps the content for the rest
 * of the step. The component-level pieces are covered by hint-content.test.ts;
 * what is exercised here is the WIRING — fact positions, the projection the
 * StepView reads, and the popup state machine.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Fact, QuestSnapshot } from '../../../lib/shared-model';
import { HINT, answerStep, buyHintFromChip, hintChip } from '../../player/__tests__/hint-fixtures';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));

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

vi.mock('../../../lib/player-stats', () => ({
  foldLocalPlayerStats: () => ({ balance: 0 }),
  gatherOtherAttemptLogs: vi.fn(async () => []),
}));

vi.mock('../sound', () => ({ coinChime: vi.fn(), spendChime: vi.fn() }));

const appended: Fact[] = [];
/** Mutable hydration payload so a test can reopen an attempt with existing facts. */
const hydration = { facts: [] as Fact[], lastStepIdx: 0, showStartGate: false };

vi.mock('../../../lib/queue', async () => {
  const real = await vi.importActual<typeof import('../../../lib/queue')>('../../../lib/queue');
  return {
    factNaturalKey: real.factNaturalKey,
    ensureActiveAttempt: vi.fn(async () => ({ attempt_key: 'att-1' })),
    getFacts: vi.fn(async () => []),
    setLastStepIdx: vi.fn(async () => {}),
    migrateLegacyLocalStorage: vi.fn(async () => {}),
    appendFact: vi.fn(async (_key: string, fact: Fact) => {
      appended.push(fact);
    }),
    openAttempt: vi.fn(async () => ({
      attempt: {
        attempt_key: 'att-1',
        created_at: new Date().toISOString(),
        last_step_idx: hydration.lastStepIdx,
      },
      facts: hydration.facts,
      queueStatus: {},
      showStartGate: hydration.showStartGate,
    })),
  };
});

import QuestPlayerClient from '../QuestPlayerClient';

/** Two-step quest: a start page and one answer step that sells a hint. */
const SNAPSHOT: QuestSnapshot = {
  golden_id: 'q-hint',
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
      template: 'task_answer',
      rich_content: { title: 'Год', main_text: 'Найдите год на табличке', question_prompt: 'Какой год?' },
      media: { hint: HINT.image },
      completion: { mode: 'answer', acceptable: [HINT.answer] },
      supporting: { hint: { cost_coins: HINT.cost, reveal_text: HINT.text } },
    },
  ],
};

/** The same quest as a snapshot whose `position` values are NOT array indices —
 *  every fact the player writes (and everything the backend reads back) keys on
 *  the array index, so the player must never consult `position` for state. */
const SHIFTED: QuestSnapshot = {
  ...SNAPSHOT,
  steps: SNAPSHOT.steps.map((s, i) => ({ ...s, position: (i + 1) * 10 })),
};

async function openAnswerStep(snapshot: QuestSnapshot = SNAPSHOT) {
  render(<QuestPlayerClient snapshot={snapshot} questId="q-hint" snapshotId="snap-1" />);
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: 'начать квест' }));
  await screen.findByPlaceholderText('Введите ответ');
  return user;
}

beforeEach(() => {
  appended.length = 0;
  hydration.facts = [];
  hydration.lastStepIdx = 0;
  hydration.showStartGate = false;
});

const PURCHASED_AT_STEP_1: Fact = {
  type: 'hint_purchased',
  step_position: 1,
  submitted_value: null,
  local_is_correct: true,
  coins_delta: -HINT.cost,
  note: HINT.text,
  device_id: 'dev-test',
};

describe('hint during play', () => {
  it('sells the hint from the always-visible paper chip', async () => {
    const user = await openAnswerStep();
    await user.click(hintChip());
    expect(appended.some((f) => f.type === 'hint_purchased' && f.coins_delta === -HINT.cost)).toBe(true);
  });

  it('offers the popup from the SECOND wrong answer', async () => {
    const user = await openAnswerStep();
    await answerStep(user, '1700');
    expect(screen.queryByText('Нужна подсказка?')).toBeNull();
    await answerStep(user, '1701');
    expect(await screen.findByText('Нужна подсказка?')).toBeTruthy();
  });

  it('shows the purchased hint in the reveal popup, then inline for the rest of the step', async () => {
    const user = await openAnswerStep();
    await user.click(hintChip());

    // Reveal popup with both text and image.
    const popup = (await screen.findByRole('button', { name: 'Понятно' })).closest('.p-popup')!;
    expect(popup.textContent).toContain(HINT.text);
    expect(popup.querySelector('img')?.getAttribute('src')).toBe(HINT.image);

    // Dismiss → the inline box keeps the hint on the step.
    await user.click(screen.getByRole('button', { name: 'Понятно' }));
    await waitFor(() => expect(document.querySelector('.p-popup')).toBeNull());
    expect(document.querySelector('.p-hintbox')?.textContent).toContain(HINT.text);
    // …and the chip is gone (nothing left to sell).
    expect(screen.queryByText(new RegExp(`подсказка · ${HINT.cost}`))).toBeNull();
  });

  it('keeps the purchased hint after a reload (rehydrated from the fact log)', async () => {
    hydration.facts = [PURCHASED_AT_STEP_1];
    hydration.lastStepIdx = 1;
    hydration.showStartGate = true; // an in-progress attempt hydrates behind the gate
    render(<QuestPlayerClient snapshot={SNAPSHOT} questId="q-hint" snapshotId="snap-1" />);
    const user = userEvent.setup();
    // An in-progress attempt hydrates behind the start gate.
    await user.click(await screen.findByRole('button', { name: 'продолжить попытку' }));
    await screen.findByPlaceholderText('Введите ответ');
    expect(document.querySelector('.p-hintbox')?.textContent).toContain(HINT.text);
  });

  it('keys hint state on the array index, not the snapshot `position` field', async () => {
    const user = await openAnswerStep(SHIFTED);
    await buyHintFromChip(user);
    expect(document.querySelector('.p-hintbox')?.textContent).toContain(HINT.text);
  });
});
