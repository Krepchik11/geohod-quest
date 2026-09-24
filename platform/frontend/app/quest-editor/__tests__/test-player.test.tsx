// @vitest-environment jsdom
/**
 * Конструкторский тест-игрок (TestOverlay/DraftRun) обязан вести себя как
 * настоящий плеер: те же аффордансы, тот же попап неверного ответа, тот же
 * инлайн-бокс, та же цена пропуска. Автор проверяет черновик именно здесь —
 * расхождение означает, что он тестирует не то, что увидит игрок.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { newQuest, newStep, type CtorQuest } from '../../../lib/constructor-model';
import { HINT, answerStep, buyHintFromChip, hintChip } from '../../player/__tests__/hint-fixtures';
import { TestOverlay } from '../TestPlayer';

vi.mock('../../quest/sound', () => ({ coinChime: vi.fn(), spendChime: vi.fn() }));

/** Черновик: старт → шаг с ответом и подсказкой → поздравление. */
function draftWithHint(skipCost?: number): CtorQuest {
  const quest = newQuest({ title: 'Тестовый квест', skipCost });
  const task = newStep('task_answer');
  task.name = 'Год';
  task.text = 'Найдите год на табличке';
  task.acceptable = [HINT.answer];
  task.hint = { on: true, cost: HINT.cost, text: HINT.text, image: null, imageOrigin: null };
  quest.steps = [quest.steps[0], task, quest.steps[1]];
  return quest;
}

/** Тест-игрок открывается сразу на шаге с ответом (startPos = 1). */
function openTestPlayer(skipCost?: number) {
  render(<TestOverlay quest={draftWithHint(skipCost)} startPos={1} onClose={vi.fn()} />);
  return userEvent.setup();
}

describe('конструкторский тест-игрок: каркас', () => {
  it('шаг живёт в .p-scroll — как в настоящем плеере, иначе длинный контент не прокрутить', () => {
    openTestPlayer();
    const scroll = document.querySelector('.pframe .p-scroll');
    expect(scroll).toBeTruthy();
    expect(scroll?.querySelector('.p-stepbody')).toBeTruthy();
  });
});

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

  it('каждая ошибка показывает И инлайн-ошибку, И попап (как в плеере)', async () => {
    const user = openTestPlayer();
    await answerStep(user, '1700');
    expect(await screen.findByText('Ответ неверный')).toBeTruthy();
    expect(screen.getByText('Неверно. Попробуйте ещё раз.')).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'Решу сам' }));
    await waitFor(() => expect(screen.queryByText('Ответ неверный')).toBeNull());
    await answerStep(user, '1701');
    expect(await screen.findByText('Ответ неверный')).toBeTruthy();
    expect(screen.getByText('Неверно. Попробуйте ещё раз.')).toBeTruthy();
  });

  it('после покупки попап показывает подсказку бесплатно — продавать её снова нечего', async () => {
    const user = openTestPlayer();
    await buyHintFromChip(user);
    await answerStep(user, '1700');
    const popup = (await screen.findByText('Ответ неверный')).closest('.p-popup')!;
    expect(popup.textContent).toContain(HINT.text);
    expect(screen.queryByRole('button', { name: /Подсказка −/ })).toBeNull();
  });

  it('на решённом задании ответ виден только для чтения, стрелка ведёт дальше (как в плеере)', async () => {
    const user = openTestPlayer();
    await answerStep(user, HINT.answer);
    expect(await screen.findByText('ПОЗДРАВЛЯЕМ ВЫ ПРОШЛИ КВЕСТ')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Назад' }));

    const field = (await screen.findByDisplayValue(HINT.answer)) as HTMLInputElement;
    expect(field.readOnly).toBe(true);
    expect(screen.queryByText(new RegExp(`подсказка · ${HINT.cost}`))).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Дальше' }));
    expect(await screen.findByText('ПОЗДРАВЛЯЕМ ВЫ ПРОШЛИ КВЕСТ')).toBeTruthy();
    expect(screen.queryByText('Ответ неверный')).toBeNull();
  });
});

describe('конструкторский тест-игрок: пропуск задания', () => {
  it('цена пропуска — из настроек черновика; пропуск ведёт дальше', async () => {
    const user = openTestPlayer(3);
    await answerStep(user, '1700');
    expect(
      await screen.findByText('Попробуйте ещё раз, возьмите подсказку за 5 монет или пропустите задание за 3 монеты.'),
    ).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Пропустить задание — 3 монеты' }));
    // Следующая страница черновика — поздравление.
    expect(await screen.findByText('ПОЗДРАВЛЯЕМ ВЫ ПРОШЛИ КВЕСТ')).toBeTruthy();
  });
});

describe('конструкторский тест-игрок: финал', () => {
  it('«Пропустить оценку» не мёртвая кнопка — тест завершается', async () => {
    render(<TestOverlay quest={draftWithHint()} startPos={2} onClose={vi.fn()} />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: /Пропустить оценку/ }));
    expect(await screen.findByText(/Тест окончен/)).toBeTruthy();
  });

  // Автор смотрит ровно то, что увидит игрок: монеты за оценку прилетают на
  // первое касание звезды, с той же анимацией (#113).
  it('первое касание звезды показывает монеты за оценку', async () => {
    render(<TestOverlay quest={draftWithHint()} startPos={2} onClose={vi.fn()} />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: '5 звёзд' }));
    expect(await screen.findByText('+5 монет')).toBeTruthy();
    expect(screen.getByText('За оценку')).toBeTruthy();
  });
});
