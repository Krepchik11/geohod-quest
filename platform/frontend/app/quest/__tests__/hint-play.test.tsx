// @vitest-environment jsdom
/**
 * Play-time hint flow, end to end through the REAL player (QuestPlayerClient):
 * the paper chip and the wrong-answer popup (after every wrong answer) both sell
 * the hint, the purchase opens the reveal popup, the inline hint box keeps the
 * content for the rest of the step, and the popup's skip moves on for the quest's
 * price. The component-level pieces are covered by hint-content.test.ts;
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

/** Only the IO is stubbed — the coin fold and the bonus rule stay real. */
vi.mock('../../../lib/player-stats', async () => {
  const real = await vi.importActual<typeof import('../../../lib/player-stats')>('../../../lib/player-stats');
  return { ...real, gatherOtherAttemptLogs: vi.fn(async () => []) };
});

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

/** A start page, one answer step that sells a hint, and a page after it (where a
 *  skip lands). No `skip_cost` — like every quest published before the skip. */
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
    {
      position: 2,
      template: 'continue',
      rich_content: { title: 'Дальше', main_text: 'Идём к следующей точке' },
      media: {},
      completion: { mode: 'physical' },
      supporting: {},
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
  render(<QuestPlayerClient snapshot={snapshot} questId="q-hint" snapshotId="snap-1" paidBonuses={[]} />);
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

  it('opens the wrong-answer popup on the FIRST wrong answer — hint, skip and «Решу сам»', async () => {
    const user = await openAnswerStep();
    await answerStep(user, '1700');
    expect(await screen.findByText('Ответ неверный')).toBeTruthy();
    // Both messages: the popup AND the inline line under the field.
    expect(screen.getByText('Неверно. Попробуйте ещё раз.')).toBeTruthy();
    expect(
      screen.getByText('Попробуйте ещё раз, возьмите подсказку за 5 монет или пропустите задание за 10 монет.'),
    ).toBeTruthy();
    // Light outlined hint + skip, the quest's main (solid) button for «Решу сам»;
    // the popup's own modifier keeps these three in sentence case.
    const hintBtn = screen.getByRole('button', { name: 'Подсказка −5 монет' });
    const skipBtn = screen.getByRole('button', { name: 'Пропустить задание — 10 монет' });
    const selfBtn = screen.getByRole('button', { name: 'Решу сам' });
    expect(hintBtn.className).toBe('p-btn');
    expect(skipBtn.className).toBe('p-btn');
    expect(selfBtn.className).toBe('p-btn p-btn--solid');
    expect(hintBtn.closest('.p-popup')?.classList.contains('p-popup--wrong')).toBe(true);

    // «Решу сам» closes it; the next wrong answer opens it again.
    await user.click(selfBtn);
    await waitFor(() => expect(screen.queryByText('Ответ неверный')).toBeNull());
    await answerStep(user, '1701');
    expect(await screen.findByText('Ответ неверный')).toBeTruthy();
  });

  it('after the purchase, the next wrong answer shows the hint in the popup for free', async () => {
    const user = await openAnswerStep();
    await buyHintFromChip(user);
    await answerStep(user, '1700');
    const popup = (await screen.findByText('Ответ неверный')).closest('.p-popup')!;
    expect(popup.textContent).toContain(HINT.text);
    expect(popup.querySelector('img')?.getAttribute('src')).toBe(HINT.image);
    expect(screen.queryByRole('button', { name: /Подсказка −/ })).toBeNull();
    expect(screen.getByText('Попробуйте ещё раз или пропустите задание за 10 монет.')).toBeTruthy();
  });

  it('the skip charges the quest price (10 without a stored one), records the answer, moves on — no gift', async () => {
    const user = await openAnswerStep();
    await answerStep(user, '1700');
    await user.click(await screen.findByRole('button', { name: 'Пропустить задание — 10 монет' }));
    expect(await screen.findByRole('button', { name: 'продолжить' })).toBeTruthy();
    await waitFor(() =>
      expect(appended.find((f) => f.type === 'task_skipped')).toMatchObject({
        step_position: 1,
        submitted_value: HINT.answer,
        local_is_correct: true,
        coins_delta: -10,
      }),
    );
    expect(appended.some((f) => f.type === 'gift_claimed')).toBe(false);
  });

  it('back on an answered step: the answer shows read-only and the arrow moves on, logging nothing', async () => {
    const user = await openAnswerStep();
    await answerStep(user, HINT.answer);
    await screen.findByRole('button', { name: 'продолжить' });
    await user.click(screen.getByRole('button', { name: 'Назад' }));

    const field = (await screen.findByDisplayValue(HINT.answer)) as HTMLInputElement;
    expect(field.readOnly).toBe(true);
    // Nothing left to sell on a solved step.
    expect(screen.queryByText(new RegExp(`подсказка · ${HINT.cost}`))).toBeNull();

    await waitFor(() => expect(appended.some((f) => f.type === 'answer_submitted' && f.local_is_correct)).toBe(true));
    const logged = appended.length;
    await user.click(screen.getByRole('button', { name: 'Дальше' }));
    expect(await screen.findByRole('button', { name: 'продолжить' })).toBeTruthy();
    expect(appended).toHaveLength(logged);
    expect(screen.queryByText('Ответ неверный')).toBeNull();
  });

  it('back on a skipped step: the substituted answer shows read-only and the arrow moves on', async () => {
    const user = await openAnswerStep();
    await answerStep(user, '1700');
    await user.click(await screen.findByRole('button', { name: 'Пропустить задание — 10 монет' }));
    await screen.findByRole('button', { name: 'продолжить' });
    await user.click(screen.getByRole('button', { name: 'Назад' }));

    const field = (await screen.findByDisplayValue(HINT.answer)) as HTMLInputElement;
    expect(field.readOnly).toBe(true);
    await waitFor(() => expect(appended.some((f) => f.type === 'task_skipped')).toBe(true));
    const logged = appended.length;
    await user.click(screen.getByRole('button', { name: 'Дальше' }));
    expect(await screen.findByRole('button', { name: 'продолжить' })).toBeTruthy();
    expect(appended).toHaveLength(logged);
  });

  it('a quest priced at 0 skips for free: no price in the text or on the button', async () => {
    const user = await openAnswerStep({ ...SNAPSHOT, skip_cost: 0 });
    await answerStep(user, '1700');
    expect(
      await screen.findByText('Попробуйте ещё раз, возьмите подсказку за 5 монет или пропустите задание.'),
    ).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Пропустить задание' }));
    await waitFor(() => expect(appended.find((f) => f.type === 'task_skipped')?.coins_delta).toBe(0));
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
    render(<QuestPlayerClient snapshot={SNAPSHOT} questId="q-hint" snapshotId="snap-1" paidBonuses={[]} />);
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
