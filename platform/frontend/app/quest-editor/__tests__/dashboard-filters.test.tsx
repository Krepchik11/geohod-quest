// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import React from 'react';
import Dashboard, { type DashboardActions } from '../Dashboard';
import type { ConstructorQuestWire } from '../../../lib/api';

/**
 * Dashboard attribute filters — the quest list filters by complexity, age
 * target and tag alongside the existing search + status. Rules under test:
 * - each attribute select narrows the list to matching rows;
 * - the tag select offers exactly the tags present across the quests;
 * - «Сбросить фильтры» clears attribute filters too.
 */
function quest(over: Partial<ConstructorQuestWire>): ConstructorQuestWire {
  return {
    quest_id: 'q1',
    name: 'Квест',
    author: 'Мария',
    author_id: 'a1',
    status: 'draft',
    steps: 3,
    completed: 0,
    buyers: 0,
    published_version: null,
    complexity: 'medium',
    age_target: 'everyone',
    tags: [],
    cover: null,
    created_at: 1,
    updated_at: 1,
    ...over,
  };
}

const QUESTS: ConstructorQuestWire[] = [
  quest({ quest_id: 'q1', name: 'Страшилки', complexity: 'high', age_target: '18plus', tags: ['хоррор'] }),
  quest({ quest_id: 'q2', name: 'Детская прогулка', complexity: 'low', age_target: 'kids', tags: ['приключения'] }),
  quest({ quest_id: 'q3', name: 'Обычный', complexity: 'medium', age_target: 'everyone', tags: ['хоррор', 'юмор'] }),
];

function setup(quests: ConstructorQuestWire[] = QUESTS) {
  const actions: DashboardActions = {
    onCreate: vi.fn(),
    onEdit: vi.fn(),
    onRun: vi.fn(),
    onDuplicate: vi.fn(),
    onDelete: vi.fn(),
    onStatusChange: vi.fn(),
    onOpenPublish: vi.fn(),
  };
  render(
    <Dashboard
      quests={quests}
      loading={false}
      error={null}
      toast={null}
      actions={actions}
    />,
  );
}

describe('Dashboard thumbnails', () => {
  it('renders the quest cover when the list carries one, letter tile otherwise', () => {
    setup([
      quest({ quest_id: 'q1', name: 'С обложкой', cover: '/api/media/coverhash' }),
      quest({ quest_id: 'q2', name: 'Без обложки' }),
    ]);
    const img = document.querySelector('.qcd-thumb img');
    expect(img?.getAttribute('src')).toBe('/api/media/coverhash');
    expect(document.querySelectorAll('.qcd-thumb img')).toHaveLength(1);
    expect(document.querySelectorAll('.qcd-thumb span')[0]?.textContent).toBe('Б');
  });

  it('falls back to the letter tile when the cover image fails to load', () => {
    setup([quest({ quest_id: 'q1', name: 'Сломанная обложка', cover: '/api/media/gone' })]);
    const img = document.querySelector('.qcd-thumb img');
    expect(img).toBeTruthy();
    fireEvent.error(img!);
    expect(document.querySelector('.qcd-thumb img')).toBeNull();
    expect(document.querySelector('.qcd-thumb span')?.textContent).toBe('С');
  });
});

describe('Dashboard attribute filters', () => {
  it('filters by complexity', () => {
    setup();
    fireEvent.change(screen.getByLabelText('Сложность'), { target: { value: 'high' } });
    expect(screen.getByText('Страшилки')).toBeTruthy();
    expect(screen.queryByText('Детская прогулка')).toBeNull();
    expect(screen.queryByText('Обычный')).toBeNull();
  });

  it('filters by age target', () => {
    setup();
    fireEvent.change(screen.getByLabelText('Возраст'), { target: { value: 'kids' } });
    expect(screen.getByText('Детская прогулка')).toBeTruthy();
    expect(screen.queryByText('Страшилки')).toBeNull();
  });

  it('filters by tag and offers exactly the tags present', () => {
    setup();
    const tagSelect = screen.getByLabelText('Тег') as HTMLSelectElement;
    const options = Array.from(tagSelect.options).map((o) => o.value);
    expect(options).toEqual(['', 'приключения', 'хоррор', 'юмор']);
    fireEvent.change(tagSelect, { target: { value: 'хоррор' } });
    expect(screen.getByText('Страшилки')).toBeTruthy();
    expect(screen.getByText('Обычный')).toBeTruthy();
    expect(screen.queryByText('Детская прогулка')).toBeNull();
  });

  it('attribute filters combine with each other', () => {
    setup();
    fireEvent.change(screen.getByLabelText('Тег'), { target: { value: 'хоррор' } });
    fireEvent.change(screen.getByLabelText('Сложность'), { target: { value: 'medium' } });
    expect(screen.getByText('Обычный')).toBeTruthy();
    expect(screen.queryByText('Страшилки')).toBeNull();
  });

  it('«Сбросить фильтры» clears attribute filters', () => {
    setup();
    fireEvent.change(screen.getByLabelText('Сложность'), { target: { value: 'high' } });
    fireEvent.change(screen.getByLabelText('Возраст'), { target: { value: 'kids' } });
    // Contradictory filters ⇒ no results ⇒ the reset affordance appears.
    fireEvent.click(screen.getByText('Сбросить фильтры'));
    expect(screen.getByText('Страшилки')).toBeTruthy();
    expect(screen.getByText('Детская прогулка')).toBeTruthy();
    expect(screen.getByText('Обычный')).toBeTruthy();
  });
});
