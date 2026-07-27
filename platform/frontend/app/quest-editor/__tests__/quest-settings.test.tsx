// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import React from 'react';
import { QuestSettings } from '../Builder';
import { BAD_START_COORDS_TEXT, newQuest } from '../../../lib/constructor-model';

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
  render(<QuestSettings quest={quest} onMeta={onMeta} />);
  return { quest, onMeta };
}

describe('QuestSettings block order', () => {
  it('puts the cover right after the quest card — the two describe the same store listing', () => {
    setup();
    const titles = screen.getAllByRole('heading', { level: 4 }).map((h) => h.textContent ?? '');
    const card = titles.findIndex((t) => t.startsWith('Карточка квеста'));
    const cover = titles.findIndex((t) => t.startsWith('Обложка'));
    expect(card).toBeGreaterThanOrEqual(0);
    expect(cover).toBe(card + 1);
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
