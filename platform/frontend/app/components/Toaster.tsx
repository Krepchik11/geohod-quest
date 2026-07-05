'use client';

import React, { useEffect, useState } from 'react';

/**
 * §4.2 shared toast — the app-wide replacement for alert() (banned). Mounted
 * once in the root layout; anywhere in client code call
 * `toast('…', { label: 'Повторить', onClick })`.
 *
 * Module-level store (no context): the layout owns exactly one Toaster, and
 * callers shouldn't need a provider to report an error.
 */
export interface ToastAction {
  label: string;
  onClick: () => void;
}

interface ToastItem {
  id: number;
  message: string;
  action?: ToastAction;
}

type Listener = (items: ToastItem[]) => void;

let items: ToastItem[] = [];
let nextId = 1;
const listeners = new Set<Listener>();

function emit() {
  for (const l of listeners) l(items);
}

const TOAST_MS = 5000;

/** Show a toast. Returns the dismiss function. */
export function toast(message: string, action?: ToastAction): () => void {
  const id = nextId++;
  items = [...items, { id, message, action }];
  emit();
  const dismiss = () => {
    items = items.filter((t) => t.id !== id);
    emit();
  };
  setTimeout(dismiss, TOAST_MS);
  return dismiss;
}

export default function Toaster() {
  const [list, setList] = useState<ToastItem[]>(items);
  useEffect(() => {
    const l: Listener = (v) => setList(v);
    listeners.add(l);
    return () => { listeners.delete(l); };
  }, []);
  if (!list.length) return null;
  return (
    <div className="toaster" role="status" aria-live="polite">
      {list.map((t) => (
        <div className="toaster__toast" key={t.id}>
          <span>{t.message}</span>
          {t.action && (
            <button
              type="button"
              onClick={() => {
                t.action!.onClick();
                items = items.filter((x) => x.id !== t.id);
                emit();
              }}
            >
              {t.action.label}
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
