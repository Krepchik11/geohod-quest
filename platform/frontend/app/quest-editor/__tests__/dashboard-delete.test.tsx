// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import React from 'react';
import Dashboard, { type DashboardActions } from '../Dashboard';
import type { ConstructorQuestWire } from '../../../lib/api';

/**
 * Dashboard: deleting a quest that has a published version takes it off sale and
 * its buyers lose access — the confirmation says so BEFORE the click (with the
 * buyer count). «Запустить» is always a test run of the draft, published or not.
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

function setup(q: ConstructorQuestWire) {
  const actions: DashboardActions = {
    onCreate: vi.fn(),
    onEdit: vi.fn(),
    onRun: vi.fn(),
    onDuplicate: vi.fn(),
    onDelete: vi.fn(),
    onStatusChange: vi.fn(),
    onOpenPublish: vi.fn(),
  };
  const view = render(<Dashboard quests={[q]} loading={false} error={null} toast={null} actions={actions} />);
  return { actions, view };
}

const openDelete = () => fireEvent.click(screen.getByTitle('Удалить'));

describe('dashboard: deleting a quest', () => {
  it('a published quest with buyers: warns it leaves the store and how many lose access', () => {
    setup(quest({ status: 'published', published_version: 2, buyers: 3 }));
    openDelete();
    expect(screen.getByText('Квест пропадёт из магазина.')).toBeTruthy();
    expect(screen.getByText(/Купившие \(3\) потеряют к нему доступ\./)).toBeTruthy();
  });

  it('warns even when the quest was already moved off the store — its listing still goes', () => {
    setup(quest({ status: 'test', published_version: 1, buyers: 0 }));
    openDelete();
    expect(screen.getByText('Квест пропадёт из магазина.')).toBeTruthy();
    expect(screen.queryByText(/Купившие/)).toBeNull();
  });

  it('a never-published draft: no store warning', () => {
    setup(quest({ status: 'draft', published_version: null }));
    openDelete();
    expect(screen.queryByText('Квест пропадёт из магазина.')).toBeNull();
  });

  it('confirming deletes the quest', () => {
    const q = quest({ status: 'published', published_version: 1, buyers: 1 });
    const { actions, view } = setup(q);
    openDelete();
    fireEvent.click(view.container.ownerDocument.querySelector('.qcd-modal__confirm')!);
    expect(actions.onDelete).toHaveBeenCalledWith(q);
  });

  it('asks whether to delete for good, naming the quest', () => {
    setup(quest({ name: 'Тайна крепости' }));
    openDelete();
    const dialog = screen.getByRole('dialog', { name: 'Вы хотите удалить квест безвозвратно?' });
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(dialog.textContent).toContain('Квест «Тайна крепости» будет удалён');
    expect(dialog.textContent).toContain('Восстановить его будет нельзя.');
  });

  it('focuses «Отмена», so a stray Enter cannot delete', () => {
    setup(quest({}));
    openDelete();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Отмена' }));
  });

  it.each([
    ['«Отмена»', () => fireEvent.click(screen.getByRole('button', { name: 'Отмена' }))],
    ['a click outside', () => fireEvent.click(document.querySelector('.qcd-ovl')!)],
    ['Escape', () => fireEvent.keyDown(document, { key: 'Escape' })],
  ])('%s closes without deleting', (_, close) => {
    const { actions } = setup(quest({}));
    openDelete();
    close();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(actions.onDelete).not.toHaveBeenCalled();
  });
});

describe('dashboard: «Запустить»', () => {
  it('is labelled a draft test run even for a published quest', () => {
    setup(quest({ status: 'published', published_version: 2 }));
    expect(screen.getByRole('button', { name: 'Запустить' }).getAttribute('title')).toBe(
      'Тестовый прогон черновика в редакторе',
    );
  });
});
