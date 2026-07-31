// @vitest-environment jsdom
/**
 * Конструкторский тест-игрок (TestOverlay/DraftRun) обязан вести себя как
 * настоящий плеер: те же аффордансы, тот же порог показа подсказки, тот же
 * инлайн-бокс. Автор проверяет черновик именно здесь — расхождение означает,
 * что он тестирует не то, что увидит игрок.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { newQuest, newStep, type CtorQuest } from '../../../lib/constructor-model';
import { HINT, answerStep, buyHintFromChip, hintChip } from '../../player/__tests__/hint-fixtures';
import { TestOverlay } from '../TestPlayer';

vi.mock('../../quest/sound', () => ({ coinChime: vi.fn(), spendChime: vi.fn() }));

/** Черновик: старт → шаг с ответом и подсказкой → поздравление. */
function draftWithHint(): CtorQuest {
  const quest = newQuest({ title: 'Тестовый квест' });
  const task = newStep('task_answer');
  task.name = 'Год';
  task.text = 'Найдите год на табличке';
  task.acceptable = [HINT.answer];
  task.hint = { on: true, cost: HINT.cost, text: HINT.text, image: null, imageOrigin: null };
  quest.steps = [quest.steps[0], task, quest.steps[1]];
  return quest;
}

/** Тест-игрок открывается сразу на шаге с ответом (startPos = 1). */
function openTestPlayer() {
  render(<TestOverlay quest={draftWithHint()} startPos={1} onClose={vi.fn()} />);
  return userEvent.setup();
}

describe('конструкторский тест-игрок: подсказка', () => {
  it('чип «подсказка» покупает подсказку и показывает её', async () => {
    const user = openTestPlayer();
    await user.click(hintChip());
    const popup = (await screen.findByRole('button', { name: 'Понятно' })).closest('.p-popup')!;
    expect(popup.textContent).toContain(HINT.text);

    await user.click(screen.getByRole('button', { name: 'Понятно' }));
    await waitFor(() => expect(document.querySelector('.p-popup')).toBeNull());
    expect(document.querySelector('.p-hintbox')?.textContent).toContain(HINT.text);
  });

  it('вторая ошибка показывает И инлайн-ошибку, И попап (как в плеере)', async () => {
    const user = openTestPlayer();
    await answerStep(user, '1700');
    expect(screen.getByText('Неверно. Попробуйте ещё раз.')).toBeTruthy();
    expect(screen.queryByText('Нужна подсказка?')).toBeNull();

    await answerStep(user, '1701');
    expect(await screen.findByText('Нужна подсказка?')).toBeTruthy();
    expect(screen.getByText('Неверно. Попробуйте ещё раз.')).toBeTruthy();
  });

  it('после покупки попап больше не предлагается', async () => {
    const user = openTestPlayer();
    await buyHintFromChip(user);
    await answerStep(user, '1700');
    await answerStep(user, '1701');
    expect(screen.queryByText('Нужна подсказка?')).toBeNull();
  });
});

describe('конструкторский тест-игрок: финал', () => {
  it('«что дальше» не мёртвая кнопка — тест завершается', async () => {
    render(<TestOverlay quest={draftWithHint()} startPos={2} onClose={vi.fn()} />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: /что дальше/ }));
    expect(await screen.findByText(/Тест окончен/)).toBeTruthy();
  });
});
