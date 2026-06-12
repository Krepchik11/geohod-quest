'use client';

import React from 'react';

/**
 * ConfirmModal - exact match design .overlay + .modal.confirm-modal (560px, centered text, danger/outline btns).
 * Used for delete quest (cabinet), etc. Narrow client, controlled.
 * Per react.md: explicit, no inner defs, small.
 */
export default function ConfirmModal({
  open,
  title,
  message,
  confirmLabel = 'Удалить квест',
  cancelLabel = 'Отмена',
  onConfirm,
  onCancel,
  danger = true,
}: {
  open: boolean;
  title?: string;
  message: React.ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
  danger?: boolean;
}) {
  if (!open) return null;

  return (
    <div
      className="overlay is-open"
      onClick={(e) => { if (e.target === e.currentTarget) onCancel(); }}
      role="dialog"
      aria-modal="true"
    >
      <div className="modal confirm-modal">
        <button
          className="modal__close"
          type="button"
          aria-label="Закрыть"
          onClick={onCancel}
        />
        <p>
          {message}
        </p>
        <div className="frow">
          <button
            className={`btn-ui ${danger ? 'btn-ui--danger' : ''}`}
            type="button"
            onClick={onConfirm}
          >
            {confirmLabel}
          </button>
          <button
            className="btn-ui btn-ui--outline"
            type="button"
            onClick={onCancel}
          >
            {cancelLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
