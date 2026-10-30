// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import React from 'react';
import { BuilderScreen, type BuilderActions } from '../Builder';
import { newQuest, newStep, type CtorQuest } from '../../../lib/constructor-model';
import { installResizeObserver } from './crop-mocks';

/**
 * Выбор шаблона новой страницы (решения владельца 2026-10-30):
 * - предлагаются «Продолжить», «Задание», «Поиск»; «Поздравление» и «Первый
 *   экран» — только если их в квесте нет; видеошаблоны скрыты;
 * - флаг ctor_page_menu: кнопка открывает меню (клавиши 1…N, Esc), а «+» между
 *   страницами вставляет страницу ровно в это место; после «Поздравления»
 *   и после последней страницы «+» нет;
 * - без флага — прежнее окно, но с тем же коротким списком.
 */
installResizeObserver();

function quest(): CtorQuest {
  const q = newQuest({ title: 'Крепость' });
  const a = { ...newStep('continue'), name: 'Крик о помощи' };
  const b = { ...newStep('task_answer'), name: 'Вопрос про знак' };
  q.steps = [q.steps[0], a, b, q.steps[1]];
  return q;
}

function setup(pageMenu: boolean, q: CtorQuest = quest(), selId: string | null = null) {
  const actions: BuilderActions = {
    onSel: vi.fn(),
    onPatchQuest: vi.fn(),
    onBack: vi.fn(),
    onTest: vi.fn(),
    onExport: vi.fn(),
    insertStep: vi.fn(),
    removeStep: vi.fn(),
    duplicateStep: vi.fn(),
    reorder: vi.fn(),
    publish: vi.fn(),
  };
  render(
    <BuilderScreen
      quest={q}
      liveVersion={null}
      sel={selId ? { type: 'page', id: selId } : { type: 'settings' }}
      saveOk
      saveFresh={false}
      justPublished={null}
      publishError={null}
      publishing={false}
      exporting={false}
      pageMenu={pageMenu}
      actions={actions}
    />,
  );
  return { actions, q };
}

const items = () =>
  within(screen.getByRole('menu', { name: 'Новая страница' }))
    .getAllByRole('menuitem')
    .map((b) => b.querySelector('.wsp-pmenu__nm')?.textContent);

describe('меню «Новая страница» (флаг ctor_page_menu)', () => {
  it('предлагает три шаблона по частоте и говорит, куда встанет страница', () => {
    setup(true);
    fireEvent.click(screen.getByRole('button', { name: '+ Добавить страницу' }));
    expect(items()).toEqual(['Продолжить', 'Задание', 'Поиск']);
    // Страница не выбрана — встанет в конец, но перед финальным «Поздравлением».
    expect(screen.getByText('Встанет после страницы 3 «Вопрос про знак»')).toBeTruthy();
  });

  it('клавиша с номером добавляет шаблон после выбранной страницы', () => {
    const q = quest();
    const { actions } = setup(true, q, q.steps[1].id);
    fireEvent.click(screen.getByRole('button', { name: '+ Добавить страницу' }));
    expect(screen.getByText('Встанет после страницы 2 «Крик о помощи»')).toBeTruthy();
    fireEvent.keyDown(screen.getByRole('menu'), { key: '2' });
    expect(actions.insertStep).toHaveBeenCalledWith('task_answer', undefined);
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('«+» между страницами вставляет ровно туда', () => {
    const { actions } = setup(true);
    fireEvent.click(screen.getByRole('button', { name: 'Вставить страницу между 2 и 3' }));
    expect(screen.getByText('Встанет после страницы 2 «Крик о помощи»')).toBeTruthy();
    fireEvent.click(within(screen.getByRole('menu')).getByRole('menuitem', { name: /Поиск/ }));
    expect(actions.insertStep).toHaveBeenCalledWith('task_no', 2);
  });

  it('нет «+» после «Поздравления» и после последней страницы', () => {
    setup(true);
    const gaps = screen.getAllByRole('button', { name: /^Вставить страницу между/ }).map((b) => b.getAttribute('aria-label'));
    expect(gaps).toEqual(['Вставить страницу между 1 и 2', 'Вставить страницу между 2 и 3', 'Вставить страницу между 3 и 4']);
  });

  it('Esc закрывает меню и возвращает фокус на кнопку', () => {
    setup(true);
    const btn = screen.getByRole('button', { name: '+ Добавить страницу' });
    fireEvent.click(btn);
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(btn);
  });

  it('стрелки меняют выбранный пункт и превью', () => {
    setup(true);
    fireEvent.click(screen.getByRole('button', { name: '+ Добавить страницу' }));
    expect(screen.getByText('Превью «Продолжить»')).toBeTruthy();
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'ArrowUp' });
    expect(screen.getByText('Превью «Поиск»')).toBeTruthy();
  });

  it('удалённое «Поздравление» предлагается снова и встаёт в конец', () => {
    const q = quest();
    q.steps = q.steps.slice(0, 3);
    const { actions } = setup(true, q, q.steps[0].id);
    fireEvent.click(screen.getByRole('button', { name: '+ Добавить страницу' }));
    expect(items()).toEqual(['Продолжить', 'Задание', 'Поиск', 'Поздравление']);
    fireEvent.mouseEnter(within(screen.getByRole('menu')).getByRole('menuitem', { name: /Поздравление/ }));
    expect(screen.getByText('Встанет после страницы 3 «Вопрос про знак»')).toBeTruthy();
    fireEvent.keyDown(screen.getByRole('menu'), { key: '4' });
    expect(actions.insertStep).toHaveBeenCalledWith('congrats', undefined);
  });
});

describe('без флага — прежнее окно с коротким списком', () => {
  it('показывает только «Продолжить», «Задание», «Поиск» и нет «+» между страницами', () => {
    setup(false);
    expect(screen.queryAllByRole('button', { name: /^Вставить страницу между/ })).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: '+ Добавить страницу' }));
    const names = [...document.querySelectorAll('.wsp-tcell .nm')].map((n) => n.textContent);
    expect(names).toEqual(['Продолжить', 'Задание', 'Поиск']);
  });
});
