// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import React from 'react';
import { QuestSettings, type AuthorTransfer } from '../Builder';
import { BAD_START_COORDS_TEXT, BAD_THEME_CONTRAST_TEXT, newQuest } from '../../../lib/constructor-model';
import { PAPER_THEME } from '../../../lib/quest-theme';

/**
 * Настройки квеста — attribute editing. Rules under test:
 * - complexity / age selects show the stored values and patch meta on change;
 * - a custom tag is added via the input (Enter or the add button), duplicates
 *   and blanks are ignored;
 * - suggested tags add on click and disappear once present;
 * - a chip's remove button deletes the tag.
 */
function setup(metaPatch: Parameters<typeof newQuest>[0] = {}) {
  const quest = newQuest({ title: 'X', ...metaPatch });
  const onMeta = vi.fn();
  const { container } = render(<QuestSettings quest={quest} onMeta={onMeta} />);
  return { quest, onMeta, container };
}

/** True when `a` precedes `b` in document order. */
function precedes(a: Element, b: Element): boolean {
  return !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
}

describe('QuestSettings cover placement', () => {
  it('edits the cover inside the quest card, between the title and city — the first screen’s own order', () => {
    setup();
    const title = screen.getByLabelText('Название');
    const cover = screen.getByRole('button', { name: 'Загрузить изображение: обложка' });
    const city = screen.getByLabelText('Город');
    expect(precedes(title, cover)).toBe(true);
    expect(precedes(cover, city)).toBe(true);
  });

  it('keeps no separate cover block — one card block describes the whole store listing', () => {
    setup();
    const titles = screen.getAllByRole('heading', { level: 4 }).map((h) => h.textContent ?? '');
    expect(titles.some((t) => t.startsWith('Обложка'))).toBe(false);
  });

  it('anchors the «Исправить →» cover gate on the zone that now lives in the card', () => {
    const { container } = setup();
    const anchor = container.querySelector('[data-gate-field="cover"]');
    expect(anchor).not.toBeNull();
    expect(anchor!.contains(screen.getByRole('button', { name: 'Загрузить изображение: обложка' }))).toBe(true);
  });
});

describe('QuestSettings attributes', () => {
  it('shows stored complexity/age and patches meta on change', () => {
    const { onMeta } = setup({ complexity: 'high', ageTarget: '18plus' });
    const complexity = screen.getByLabelText('Сложность') as HTMLSelectElement;
    const age = screen.getByLabelText('Возраст') as HTMLSelectElement;
    expect(complexity.value).toBe('high');
    expect(age.value).toBe('18plus');

    fireEvent.change(complexity, { target: { value: 'low' } });
    expect(onMeta).toHaveBeenLastCalledWith(expect.objectContaining({ complexity: 'low' }));
    fireEvent.change(age, { target: { value: 'kids' } });
    expect(onMeta).toHaveBeenLastCalledWith(expect.objectContaining({ ageTarget: 'kids' }));
  });

  it('adds a custom tag via Enter, ignoring blanks and duplicates', () => {
    const { onMeta } = setup({ tags: ['юмор'] });
    const input = screen.getByPlaceholderText('Свой тег…');

    fireEvent.change(input, { target: { value: '  мистика  ' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onMeta).toHaveBeenLastCalledWith(expect.objectContaining({ tags: ['юмор', 'мистика'] }));

    onMeta.mockClear();
    fireEvent.change(input, { target: { value: '   ' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    fireEvent.change(input, { target: { value: 'юмор' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onMeta).not.toHaveBeenCalled();
  });

  it('adds a suggested tag on click and hides it once present', () => {
    const { onMeta } = setup({ tags: ['хоррор'] });
    // «хоррор» is already on the quest — its suggestion chip is gone.
    expect(screen.queryByRole('button', { name: '+ хоррор' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '+ юмор' }));
    expect(onMeta).toHaveBeenLastCalledWith(expect.objectContaining({ tags: ['хоррор', 'юмор'] }));
  });

  it('removes a tag via its chip button', () => {
    const { onMeta } = setup({ tags: ['хоррор', 'юмор'] });
    fireEvent.click(screen.getByRole('button', { name: 'Убрать тег «хоррор»' }));
    expect(onMeta).toHaveBeenLastCalledWith(expect.objectContaining({ tags: ['юмор'] }));
  });
});

describe('QuestSettings start point', () => {
  it('shows the stored coordinates and patches meta on change', () => {
    const { onMeta } = setup({ startCoords: '45.2651, 19.8656' });
    const input = screen.getByLabelText('Координаты места старта') as HTMLInputElement;
    expect(input.value).toBe('45.2651, 19.8656');
    fireEvent.change(input, { target: { value: '44.8176, 20.4569' } });
    expect(onMeta).toHaveBeenLastCalledWith(expect.objectContaining({ startCoords: '44.8176, 20.4569' }));
  });

  it('flags unparseable coordinates inline with the publish gate’s own wording', () => {
    setup({ startCoords: '45.2651 19.8656' });
    expect(screen.getByText(BAD_START_COORDS_TEXT, { exact: false })).toBeTruthy();
  });

  it('says nothing when the field is blank or valid', () => {
    setup({ startCoords: '' });
    expect(screen.queryByText(BAD_START_COORDS_TEXT, { exact: false })).toBeNull();
  });
});

describe('QuestSettings universal answer', () => {
  it('shows the stored value and patches meta on change', () => {
    const { onMeta } = setup({ universalAnswer: '11' });
    const input = screen.getByLabelText('Универсальный ответ') as HTMLInputElement;
    expect(input.value).toBe('11');
    fireEvent.change(input, { target: { value: '42' } });
    expect(onMeta).toHaveBeenLastCalledWith(expect.objectContaining({ universalAnswer: '42' }));
  });

  it('clearing the input disables the feature (empty = off)', () => {
    const { onMeta } = setup({ universalAnswer: '11' });
    const input = screen.getByLabelText('Универсальный ответ');
    fireEvent.change(input, { target: { value: '' } });
    expect(onMeta).toHaveBeenLastCalledWith(expect.objectContaining({ universalAnswer: '' }));
  });
});

/**
 * Передача квеста другому автору (#100). Блок появляется только когда его
 * данные переданы — конструктор показывает его администраторам; сервер
 * отказывает всем остальным независимо от этого.
 */
describe('QuestSettings author transfer', () => {
  const transfer = (over: Partial<AuthorTransfer> = {}): AuthorTransfer => ({
    current: { id: 'u-1', name: 'Первый автор' },
    candidates: [
      { user_id: 'u-1', name: 'Первый автор', role: 'editor' },
      { user_id: 'u-2', name: 'Второй автор', role: 'admin' },
    ],
    onTransfer: vi.fn().mockResolvedValue(undefined),
    ...over,
  });

  it('is absent for an editor (no transfer data passed)', () => {
    render(<QuestSettings quest={newQuest({ title: 'X' })} onMeta={vi.fn()} />);
    expect(screen.queryByLabelText('Автор квеста')).toBeNull();
  });

  it('shows the current author preselected and hands the quest over on confirm', () => {
    const t = transfer();
    render(<QuestSettings quest={newQuest({ title: 'X' })} onMeta={vi.fn()} transfer={t} />);
    const select = screen.getByLabelText('Автор квеста') as HTMLSelectElement;
    expect(select.value).toBe('u-1');

    fireEvent.change(select, { target: { value: 'u-2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Передать квест' }));
    expect(t.onTransfer).toHaveBeenCalledWith('u-2');
  });

  it('cannot hand the quest to its current author, and says so', () => {
    const t = transfer();
    render(<QuestSettings quest={newQuest({ title: 'X' })} onMeta={vi.fn()} transfer={t} />);
    expect((screen.getByRole('button', { name: 'Передать квест' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('reports a failed handover', async () => {
    const t = transfer({ onTransfer: vi.fn().mockRejectedValue(new Error('Сервер недоступен')) });
    render(<QuestSettings quest={newQuest({ title: 'X' })} onMeta={vi.fn()} transfer={t} />);
    fireEvent.change(screen.getByLabelText('Автор квеста'), { target: { value: 'u-2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Передать квест' }));
    expect(await screen.findByText(/Сервер недоступен/)).toBeTruthy();
  });
});

/**
 * Цвета квеста (#101). Блок есть всегда — это часть квеста, а не право доступа;
 * пока тумблер выключен, квест играется в стандартной палитре.
 */
describe('QuestSettings colours', () => {
  const themed = () => {
    const quest = newQuest({ title: 'X' });
    const onMeta = vi.fn();
    render(<QuestSettings quest={quest} onMeta={onMeta} />);
    return { quest, onMeta };
  };

  it('starts off — no colour inputs until the author asks for their own', () => {
    themed();
    expect(screen.queryByLabelText(/Фон/)).toBeNull();
    expect(screen.getByText('Свои цвета')).toBeTruthy();
  });

  it('turning it on seeds the paper palette so nothing jumps', () => {
    const { onMeta } = themed();
    fireEvent.click(screen.getByText('Свои цвета'));
    expect(onMeta).toHaveBeenCalledWith(expect.objectContaining({ theme: PAPER_THEME }));
  });

  it('edits one colour and leaves the other two alone', () => {
    const quest = newQuest({ title: 'X', theme: PAPER_THEME });
    const onMeta = vi.fn();
    render(<QuestSettings quest={quest} onMeta={onMeta} />);
    fireEvent.change(screen.getByLabelText(/Фон/), { target: { value: '#101014' } });
    expect(onMeta).toHaveBeenCalledWith(
      expect.objectContaining({ theme: { ...PAPER_THEME, bg: '#101014' } }),
    );
  });

  it('says so when the chosen colours make the text unreadable', () => {
    const quest = newQuest({ title: 'X', theme: { bg: '#101014', ink: '#14141a', btn: '#C9A227' } });
    render(<QuestSettings quest={quest} onMeta={vi.fn()} />);
    expect(screen.getByText(new RegExp(BAD_THEME_CONTRAST_TEXT))).toBeTruthy();
  });
});
