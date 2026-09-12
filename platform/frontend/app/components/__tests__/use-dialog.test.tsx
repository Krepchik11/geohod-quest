// @vitest-environment jsdom
/**
 * What a dialog owes the keyboard.
 *
 * The app opens a dozen sheets — buy a quest, rename yourself, delete the
 * account, confirm a publish — and each one used to decide for itself whether
 * Escape closed it (most did not) and where the focus went (nowhere: it stayed
 * on the page behind, so Tab walked straight out of the sheet into the content
 * it was covering). Three of the twelve had a hand-rolled Escape listener; the
 * rest had none.
 *
 * These are the rules, once, for all of them.
 */
import React, { useState } from 'react';
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useDialog } from '../useDialog';

function Harness({ onClose }: { onClose?: () => void } = {}) {
  const [open, setOpen] = useState(false);
  const close = () => {
    setOpen(false);
    onClose?.();
  };
  const dialog = useDialog(close, open);
  return (
    <div>
      <button type="button" onClick={() => setOpen(true)}>
        Открыть
      </button>
      <button type="button">Сзади</button>
      {open && (
        <div ref={dialog} role="dialog" aria-modal="true" aria-label="Тест" tabIndex={-1}>
          <button type="button">Первая</button>
          <button type="button">Последняя</button>
        </div>
      )}
    </div>
  );
}

const open = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.click(screen.getByRole('button', { name: 'Открыть' }));
  return screen.getByRole('dialog');
};

describe('useDialog', () => {
  it('closes on Escape', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await open(user);
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('moves focus into the dialog so the keyboard starts where the eye is', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const dialog = await open(user);
    expect(dialog.contains(document.activeElement)).toBe(true);
  });

  it('keeps Tab inside the dialog instead of walking into the page behind it', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await open(user);
    const first = screen.getByRole('button', { name: 'Первая' });
    const last = screen.getByRole('button', { name: 'Последняя' });

    last.focus();
    await user.tab();
    expect(document.activeElement).toBe(first);

    await user.tab({ shift: true });
    expect(document.activeElement).toBe(last);
  });

  it('gives focus back to whatever opened it', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const trigger = screen.getByRole('button', { name: 'Открыть' });
    await open(user);
    await user.keyboard('{Escape}');
    expect(document.activeElement).toBe(trigger);
  });

  it('does nothing at all while closed', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const behind = screen.getByRole('button', { name: 'Сзади' });
    behind.focus();
    await user.keyboard('{Escape}');
    expect(document.activeElement).toBe(behind);
  });
});
