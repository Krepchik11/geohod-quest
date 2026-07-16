// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import React from 'react';

/**
 * Shared admin-page primitives (app/admin/ui.tsx) — ONE page head, confirm
 * sheet and toast for every admin tab, so Users/Coupons/Features/Stats wear
 * identical scaffolding instead of four per-page copies.
 */
import { AdminPageHead, AdminConfirmSheet, AdminToast } from '../ui';

describe('AdminPageHead', () => {
  it('renders eyebrow, h1 title, optional lede and actions', () => {
    render(
      <AdminPageHead eyebrow="УПРАВЛЕНИЕ" title="Купоны" lede="Пояснение.">
        <button type="button">Новый купон</button>
      </AdminPageHead>,
    );
    expect(screen.getByText('УПРАВЛЕНИЕ')).toBeTruthy();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Купоны');
    expect(screen.getByText('Пояснение.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Новый купон' })).toBeTruthy();
  });
});

describe('AdminConfirmSheet', () => {
  const base = {
    label: 'Сменить роль',
    title: 'Сменить роль?',
    text: 'Доступ изменится сразу.',
    applyLabel: 'Назначить',
    busyLabel: 'Сохраняем…',
    busy: false,
    onCancel: vi.fn(),
    onApply: vi.fn(),
  };

  it('is a modal dialog; apply and cancel fire; backdrop click cancels', () => {
    const onCancel = vi.fn();
    const onApply = vi.fn();
    render(<AdminConfirmSheet {...base} onCancel={onCancel} onApply={onApply} />);
    const dialog = screen.getByRole('dialog', { name: 'Сменить роль' });
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: 'Назначить' }));
    expect(onApply).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Отмена' }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('presentation'));
    expect(onCancel).toHaveBeenCalledTimes(2);
  });

  it('busy: shows the busy label, disables both buttons, backdrop stops cancelling', () => {
    const onCancel = vi.fn();
    render(<AdminConfirmSheet {...base} busy onCancel={onCancel} />);
    const apply = screen.getByRole('button', { name: 'Сохраняем…' });
    expect((apply as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Отмена' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('presentation'));
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('danger variant marks the apply button', () => {
    render(<AdminConfirmSheet {...base} danger applyLabel="Удалить" />);
    expect(
      screen.getByRole('button', { name: 'Удалить' }).className,
    ).toContain('ap-sheet-apply--danger');
  });
});

describe('AdminToast', () => {
  it('renders a status toast; error variant flips the style and glyph', () => {
    const { rerender } = render(<AdminToast text="Роль обновлена" />);
    const toast = screen.getByRole('status');
    expect(toast.textContent).toContain('Роль обновлена');
    expect(toast.className).not.toContain('ap-toast--error');
    rerender(<AdminToast text="Не удалось" error />);
    expect(screen.getByRole('status').className).toContain('ap-toast--error');
  });
});
