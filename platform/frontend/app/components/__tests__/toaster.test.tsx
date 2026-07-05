// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import React from 'react';
import Toaster, { toast } from '../Toaster';

/**
 * §4.2 shared toast — replaces alert() everywhere (banned). One Toaster mounts
 * in the root layout; `toast(message, action?)` shows a dark pill with an
 * optional inline action («Повторить»).
 */
describe('Toaster', () => {
  it('shows a message and auto-dismisses', async () => {
    vi.useFakeTimers();
    render(<Toaster />);
    act(() => { toast('Не удалось скачать квест — проверьте связь'); });
    expect(screen.getByText('Не удалось скачать квест — проверьте связь')).toBeTruthy();
    act(() => { vi.advanceTimersByTime(6000); });
    expect(screen.queryByText(/Не удалось скачать/)).toBeNull();
    vi.useRealTimers();
  });

  it('runs the inline action and dismisses', async () => {
    const onRetry = vi.fn();
    render(<Toaster />);
    act(() => { toast('Не удалось скачать квест — проверьте связь', { label: 'Повторить', onClick: onRetry }); });
    fireEvent.click(screen.getByRole('button', { name: 'Повторить' }));
    expect(onRetry).toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByText(/Не удалось скачать/)).toBeNull());
  });
});
