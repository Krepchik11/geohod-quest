// @vitest-environment jsdom
/**
 * ShareQuestButton: both variants call the one share entry point, report the
 * clipboard fallback through a toast, and — critically for the shop card —
 * never let the click reach a stretched card link.
 */
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

const { shareQuestMock, toastMock } = vi.hoisted(() => ({
  shareQuestMock: vi.fn(),
  toastMock: vi.fn(),
}));
vi.mock('../../../lib/share', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  shareQuest: shareQuestMock,
}));
vi.mock('../Toaster', () => ({ toast: toastMock }));

import ShareQuestButton from '../ShareQuestButton';

const QUEST = { questId: 'q1', name: 'Загадка крепости', city: 'Нови Сад' };

beforeEach(() => {
  shareQuestMock.mockReset().mockResolvedValue('shared');
  toastMock.mockReset();
});

describe('ShareQuestButton', () => {
  it('renders the labelled button by default and shares the quest', async () => {
    render(<ShareQuestButton quest={QUEST} />);
    fireEvent.click(screen.getByRole('button', { name: 'Поделиться' }));
    expect(shareQuestMock).toHaveBeenCalledWith(QUEST);
  });

  it('renders the icon variant with an accessible name instead of text', () => {
    render(<ShareQuestButton quest={QUEST} variant="icon" />);
    const btn = screen.getByRole('button', { name: 'Поделиться квестом' });
    expect(btn.textContent).toBe('');
  });

  it('toasts when the link went to the clipboard instead of a share sheet', async () => {
    shareQuestMock.mockResolvedValue('copied');
    render(<ShareQuestButton quest={QUEST} />);
    fireEvent.click(screen.getByRole('button', { name: 'Поделиться' }));
    await vi.waitFor(() => expect(toastMock).toHaveBeenCalledWith('Ссылка на квест скопирована'));
  });

  it('stays silent when the OS sheet was used or dismissed', async () => {
    for (const outcome of ['shared', 'dismissed'] as const) {
      shareQuestMock.mockResolvedValue(outcome);
      const { unmount } = render(<ShareQuestButton quest={QUEST} />);
      fireEvent.click(screen.getByRole('button', { name: 'Поделиться' }));
      await vi.waitFor(() => expect(shareQuestMock).toHaveBeenCalled());
      expect(toastMock).not.toHaveBeenCalled();
      unmount();
    }
  });

  it('toasts a recovery hint when neither path worked', async () => {
    shareQuestMock.mockResolvedValue('failed');
    render(<ShareQuestButton quest={QUEST} />);
    fireEvent.click(screen.getByRole('button', { name: 'Поделиться' }));
    await vi.waitFor(() =>
      expect(toastMock).toHaveBeenCalledWith(
        'Не удалось поделиться — скопируйте адрес из строки браузера',
      ),
    );
  });

  // The shop card wraps its whole body in a stretched link; a share click that
  // bubbled would navigate to the product page instead of sharing.
  it('does not let the click reach an enclosing card link', () => {
    const onCardClick = vi.fn();
    render(
      <div onClick={onCardClick}>
        <ShareQuestButton quest={QUEST} variant="icon" />
      </div>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Поделиться квестом' }));
    expect(shareQuestMock).toHaveBeenCalled();
    expect(onCardClick).not.toHaveBeenCalled();
  });
});
