/**
 * Shared fixtures + driver for the hint-flow tests that assert the SAME contract on
 * two surfaces — the production player (app/quest) and the constructor's test player
 * (app/quest-editor). Keeping one driver here is the point: if each suite kept its
 * own copy of "type an answer and submit", the two could drift and the parity these
 * tests exist to guarantee would quietly stop being tested.
 *
 * Not a `.test.ts` file, so vitest's default include never collects it (same shape as
 * app/components/__tests__/chrome-mocks.ts).
 */
import { screen } from '@testing-library/react';
import type userEvent from '@testing-library/user-event';

type User = ReturnType<typeof userEvent.setup>;

/** The one hint under test, shared so the two surfaces assert identical content. */
export const HINT = {
  cost: 5,
  text: 'Цифры выбиты в арке',
  image: '/hint.jpg',
  answer: '1730',
} as const;

/** The always-visible paper chip that sells the hint. */
export const hintChip = () => screen.getByText(new RegExp(`подсказка · ${HINT.cost}`));

/** Type into the answer field and submit it, exactly as a player would. */
export async function answerStep(user: User, value: string): Promise<void> {
  const field = screen.getByPlaceholderText('Введите ответ');
  await user.clear(field);
  await user.type(field, value);
  await user.click(screen.getByRole('button', { name: 'Ответить' }));
}

/** Buy the hint from the chip and dismiss the reveal popup it opens. */
export async function buyHintFromChip(user: User): Promise<void> {
  await user.click(hintChip());
  await user.click(await screen.findByRole('button', { name: 'Понятно' }));
}
