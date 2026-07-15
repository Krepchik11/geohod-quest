// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import React from 'react';
import StatusControl from '../StatusControl';
import type { ConstructorQuestWire } from '../../../lib/api';

/**
 * §9.1 — the raw status <select> is replaced by a status chip with a menu of
 * NAMED transitions. Rules under test:
 * - a quest with NO published snapshot routes «Тест»/«Опубликовать» into the
 *   publish panel (the backend 400-guard becomes unreachable by design);
 * - with a snapshot, transitions call the API directly;
 * - «Снять с публикации…» is destructive: it opens a consequences confirm
 *   (with the honest buyers count) and only the red button fires the change.
 */
function quest(over: Partial<ConstructorQuestWire>): ConstructorQuestWire {
  return {
    quest_id: 'q1',
    name: 'Тайны старого Белграда',
    author: 'Мария',
    author_id: 'a1',
    status: 'published',
    steps: 12,
    completed: 4,
    buyers: 18,
    published_version: 4,
    complexity: 'medium',
    age_target: 'everyone',
    tags: [],
    created_at: 1,
    updated_at: 1,
    ...over,
  };
}

function setup(over: Partial<ConstructorQuestWire>) {
  const onStatusChange = vi.fn();
  const onOpenPublish = vi.fn();
  render(<StatusControl quest={quest(over)} onStatusChange={onStatusChange} onOpenPublish={onOpenPublish} />);
  return { onStatusChange, onOpenPublish };
}

describe('StatusControl', () => {
  it('shows the current status as a chip', () => {
    setup({ status: 'published' });
    expect(screen.getByRole('button', { name: /Опубликован/ })).toBeTruthy();
  });

  it('published → «Перевести в „Тест“» fires directly (snapshot exists)', () => {
    const { onStatusChange } = setup({ status: 'published' });
    fireEvent.click(screen.getByRole('button', { name: /Опубликован/ }));
    fireEvent.click(screen.getByText('Перевести в «Тест»'));
    expect(onStatusChange).toHaveBeenCalledWith('test');
  });

  it('published → «Снять с публикации…» confirms with consequences before firing', () => {
    const { onStatusChange } = setup({ status: 'published', buyers: 18 });
    fireEvent.click(screen.getByRole('button', { name: /Опубликован/ }));
    fireEvent.click(screen.getByText('Снять с публикации…'));
    // Nothing fired yet — the confirm dialog is showing honest consequences.
    expect(onStatusChange).not.toHaveBeenCalled();
    expect(screen.getByText(/Снять «Тайны старого Белграда» с публикации\?/)).toBeTruthy();
    expect(screen.getByText(/У 18 купивших доступ и прогресс сохранятся/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Снять с публикации' }));
    expect(onStatusChange).toHaveBeenCalledWith('draft');
  });

  it('confirm «Отмена» closes without firing', () => {
    const { onStatusChange } = setup({ status: 'published' });
    fireEvent.click(screen.getByRole('button', { name: /Опубликован/ }));
    fireEvent.click(screen.getByText('Снять с публикации…'));
    fireEvent.click(screen.getByRole('button', { name: 'Отмена' }));
    expect(onStatusChange).not.toHaveBeenCalled();
    expect(screen.queryByText(/с публикации\?/)).toBeNull();
  });

  it('draft WITHOUT snapshot routes test/publish into the publish panel', () => {
    const { onStatusChange, onOpenPublish } = setup({ status: 'draft', published_version: null });
    fireEvent.click(screen.getByRole('button', { name: /Проект/ }));
    fireEvent.click(screen.getByText('Перевести в «Тест»'));
    expect(onStatusChange).not.toHaveBeenCalled();
    expect(onOpenPublish).toHaveBeenCalled();
  });

  it('draft WITH a live snapshot may flip directly', () => {
    const { onStatusChange } = setup({ status: 'draft', published_version: 3 });
    fireEvent.click(screen.getByRole('button', { name: /Проект/ }));
    fireEvent.click(screen.getByText('Опубликовать'));
    expect(onStatusChange).toHaveBeenCalledWith('published');
  });

  it('menu explains that new versions go through the publish panel', () => {
    setup({ status: 'published' });
    fireEvent.click(screen.getByRole('button', { name: /Опубликован/ }));
    expect(screen.getByText(/Публикация новой версии — только через панель публикации/)).toBeTruthy();
  });
});
