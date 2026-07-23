'use client';

import React, { useEffect, useRef, useState } from 'react';

/**
 * Shared admin-page primitives (`ap-*`, styles/admin-page.css) — the ONE page
 * head, confirm bottom-sheet and toast every admin tab renders, so the tabs
 * wear identical scaffolding. Page bodies (lists, KPI cards, master-detail)
 * stay per-page; only the repeated chrome lives here.
 */

/** Eyebrow + h1 (+ optional lede) on the left, action buttons on the right. */
export function AdminPageHead({
  eyebrow,
  title,
  lede,
  className,
  children,
}: {
  eyebrow: string;
  title: string;
  lede?: React.ReactNode;
  className?: string;
  /** Right-side actions (e.g. «Новый купон»). */
  children?: React.ReactNode;
}) {
  return (
    <div className={className ? `ap-head ${className}` : 'ap-head'}>
      <div>
        <div className="ap-eyebrow">{eyebrow}</div>
        <h1 className="ap-title">{title}</h1>
        {lede && <p className="ap-lede">{lede}</p>}
      </div>
      {children}
    </div>
  );
}

/**
 * Confirm bottom-sheet (a centered modal on desktop): title + text +
 * cancel/apply. While `busy`, both buttons disable, the apply shows
 * `busyLabel`, and the backdrop stops cancelling — the action must settle.
 */
export function AdminConfirmSheet({
  label,
  title,
  text,
  applyLabel,
  busyLabel,
  busy,
  danger = false,
  onCancel,
  onApply,
}: {
  /** aria-label of the dialog. */
  label: string;
  title: string;
  text: React.ReactNode;
  applyLabel: string;
  busyLabel: string;
  busy: boolean;
  /** Destructive action — the apply button turns red. */
  danger?: boolean;
  onCancel: () => void;
  onApply: () => void;
}) {
  return (
    <div
      className="ap-sheet-backdrop"
      role="presentation"
      onClick={() => !busy && onCancel()}
    >
      <div
        className="ap-sheet"
        role="dialog"
        aria-modal="true"
        aria-label={label}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="ap-sheet-grip" aria-hidden />
        <div className="ap-sheet-title">{title}</div>
        <div className="ap-sheet-text">{text}</div>
        <div className="ap-sheet-actions">
          <button type="button" className="ap-sheet-cancel" disabled={busy} onClick={onCancel}>
            Отмена
          </button>
          <button
            type="button"
            className={`ap-sheet-apply${danger ? ' ap-sheet-apply--danger' : ''}`}
            disabled={busy}
            onClick={onApply}
          >
            {busy ? busyLabel : applyLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

/** Bottom-centered status toast; `error` flips it red with a «!» glyph. */
export function AdminToast({ text, error = false }: { text: string; error?: boolean }) {
  return (
    <div className={`ap-toast${error ? ' ap-toast--error' : ''}`} role="status">
      <span className="ap-toast-check" aria-hidden>
        {error ? '!' : '✓'}
      </span>
      {text}
    </div>
  );
}

/**
 * Auto-dismissing toast state shared by admin pages: `showToast(msg)` shows it and
 * clears it after ~2.8s; the timer is cleared on unmount. Pair with `<AdminToast>`.
 */
export function useToast(): { toast: string | null; showToast: (message: string) => void } {
  const [toast, setToast] = useState<string | null>(null);
  const timer = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (timer.current) window.clearTimeout(timer.current);
    },
    [],
  );
  const showToast = (message: string) => {
    setToast(message);
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setToast(null), 2800);
  };
  return { toast, showToast };
}
