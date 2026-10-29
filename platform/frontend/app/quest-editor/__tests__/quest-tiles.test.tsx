// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, within, waitFor } from '@testing-library/react';
import React from 'react';
import QuestTiles, { type QuestTilesActions } from '../QuestTiles';
import type { ConstructorQuestWire } from '../../../lib/api';
import { newQuest } from '../../../lib/constructor-model';

/**
 * Плитки квестов (флаг ctor_tiles): вкладки с числами, «Требуют внимания»,
 * плашка действия ведёт в панель публикации, индикаторы по статусу, деньги
 * только администратору, быстрые настройки сохраняют поля черновика.
 */
function quest(over: Partial<ConstructorQuestWire>): ConstructorQuestWire {
  return {
    quest_id: 'q1', name: 'Квест', author: 'Мария', author_id: 'a1', status: 'draft', steps: 10,
    completed: 0, buyers: 0, published_version: null, complexity: 'medium', age_target: 'everyone',
    tags: [], cover: null, created_at: 1, updated_at: 1, city: null, price: null, duration_min: 60,
    distance_km: 5, tasks: null, gate_errors: null, gate_warnings: null, unpublished_changes: null,
    rating_avg: 0, rating_count: 0, players: 0, revenue: null,
    ...over,
  };
}

const QUESTS: ConstructorQuestWire[] = [
  quest({
    quest_id: 'fort', name: 'Тайна крепости', status: 'published', published_version: 1, city: 'Нови Сад',
    price: 0, unpublished_changes: true, rating_avg: 4.97, rating_count: 58, players: 477, buyers: 470,
    revenue: 0, updated_at: 300,
  }),
  quest({
    quest_id: 'thief', name: 'Новисадский вор', status: 'published', published_version: 3, city: 'Нови Сад',
    price: 1000, unpublished_changes: false, rating_avg: 5, rating_count: 17, players: 79, buyers: 72,
    revenue: 36000, updated_at: 200, tags: ['приключения'],
  }),
  quest({
    quest_id: 'kale', name: 'Калемегдан', city: 'Белград', price: 500, gate_errors: 3, gate_warnings: 1,
    complexity: 'high', updated_at: 400,
  }),
];

function setup(isAdmin = false) {
  const actions: QuestTilesActions = {
    onCreate: vi.fn(),
    onEdit: vi.fn(),
    onRun: vi.fn(),
    onDuplicate: vi.fn(),
    onDelete: vi.fn(),
    onStatusChange: vi.fn(),
    onOpenPublish: vi.fn(),
    onCopyLink: vi.fn(),
    onExport: vi.fn(),
    loadQuest: vi.fn(async () => {
      const q = newQuest({ title: 'Тайна крепости', city: 'Нови Сад', price: 0 });
      return { ...q, meta: { ...q.meta, desc: 'Старое описание', startCoords: '' } };
    }),
    saveSettings: vi.fn(async () => {}),
  };
  render(
    <QuestTiles quests={QUESTS} loading={false} error={null} toast={null} isAdmin={isAdmin} actions={actions} />,
  );
  return actions;
}

const tile = (name: string) => screen.getByRole('article', { name });

describe('QuestTiles', () => {
  it('вкладки считают квесты, «Требуют внимания» — только правки и готовое', () => {
    setup();
    expect(screen.getByRole('tab', { name: /Все\s*3/ })).toBeTruthy();
    expect(screen.getByRole('tab', { name: /В магазине\s*2/ })).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: /Требуют внимания/ }));
    expect(screen.getAllByRole('article').map((a) => a.getAttribute('aria-label'))).toEqual(['Тайна крепости']);
  });

  it('по умолчанию сверху недавно изменённые', () => {
    setup();
    expect(screen.getAllByRole('article').map((a) => a.getAttribute('aria-label'))).toEqual([
      'Калемегдан',
      'Тайна крепости',
      'Новисадский вор',
    ]);
  });

  it('плашка правок ведёт в панель публикации с номером следующей версии', () => {
    const actions = setup();
    const t = tile('Тайна крепости');
    fireEvent.click(within(t).getAllByRole('button', { name: 'Опубликовать v2' })[0]);
    expect(actions.onOpenPublish).toHaveBeenCalledWith(QUESTS[0]);
  });

  it('индикаторы: рейтинг и игроки в магазине, ошибки у черновика', () => {
    setup();
    const fort = tile('Тайна крепости');
    expect(within(fort).getByText('4,97')).toBeTruthy();
    expect(within(fort).getByText('477')).toBeTruthy();
    const kale = tile('Калемегдан');
    expect(within(kale).getByText('3 ошибки')).toBeTruthy();
    expect(within(kale).getByText('Высокая')).toBeTruthy();
    // У черновика нет страницы в магазине — ссылку не скопировать.
    expect((within(kale).getByRole('button', { name: 'Скопировать ссылку на квест' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('деньги видит только администратор', () => {
    setup(false);
    expect(screen.queryByText(/Купили/)).toBeNull();
  });

  it('администратор видит покупки и оплаты', () => {
    setup(true);
    expect(within(tile('Новисадский вор')).getByText(/Купили/)).toBeTruthy();
    expect(within(tile('Тайна крепости')).getByText(/Получили/)).toBeTruthy();
  });

  it('быстрые настройки грузят черновик и сохраняют описание и точку старта', async () => {
    const actions = setup();
    fireEvent.click(within(tile('Тайна крепости')).getByRole('button', { name: 'Ещё действия' }));
    fireEvent.click(screen.getByRole('menuitem', { name: /Быстрые настройки/ }));
    const desc = await screen.findByLabelText('Описание для магазина');
    expect((desc as HTMLTextAreaElement).value).toBe('Старое описание');
    fireEvent.change(desc, { target: { value: 'Новое описание' } });
    fireEvent.change(screen.getByLabelText('Точка старта'), { target: { value: '45.2517, 19.8659' } });
    fireEvent.change(screen.getByLabelText('Цена, ₽'), { target: { value: '500' } });
    expect(screen.getByText(/после публикации версии 2/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }));
    await waitFor(() => expect(actions.saveSettings).toHaveBeenCalledTimes(1));
    const [row, patch] = (actions.saveSettings as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(row.quest_id).toBe('fort');
    expect(patch).toMatchObject({ desc: 'Новое описание', startCoords: '45.2517, 19.8659', price: 500 });
  });

  it('нераспознанная точка старта не даёт сохранить', async () => {
    setup();
    fireEvent.click(within(tile('Тайна крепости')).getByRole('button', { name: /Быстрые настройки/ }));
    const start = await screen.findByLabelText('Точка старта');
    fireEvent.change(start, { target: { value: 'где-то у моста' } });
    expect((screen.getByRole('button', { name: 'Сохранить' }) as HTMLButtonElement).disabled).toBe(true);
    // Бонус к счётчику — не для редактора.
    expect(screen.queryByLabelText(/Бонус к счётчику/)).toBeNull();
  });
});
