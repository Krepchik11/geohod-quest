'use client';

import { useEffect, useEffectEvent, useRef } from 'react';

/**
 * Escape закрывает наложение. Хук общий, потому что иначе каждое новое
 * наложение заново выбирает цель слушателя, зависимости и условие — а расходятся
 * они молча. `enabled` для наложений, живущих в DOM и в закрытом виде.
 */
export function useEscape(onClose: () => void, enabled = true): void {
  // Слушатель не должен переподписываться из-за новой идентичности onClose:
  // она меняется на каждом рендере родителя (§8.3 agents/react.md).
  const close = useEffectEvent(onClose);
  useEffect(() => {
    if (!enabled) return undefined;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [enabled]);
}

/** Что вообще может получить фокус внутри наложения. */
const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), ' +
  'textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function focusable(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)];
}

/**
 * Всё, что диалог должен клавиатуре: Escape закрывает, фокус входит внутрь при
 * открытии, Tab ходит по кругу внутри и возвращается на то, что диалог открыло.
 *
 * Раньше каждое наложение решало это само — и почти всегда никак: Escape был у
 * трёх из двенадцати, фокус не переносился никуда, поэтому Tab уходил из шторки
 * в страницу под ней. Правило одно, живёт здесь, и новое наложение получает его
 * даром.
 *
 * Возвращает ref, который вешается на элемент с `role="dialog"` (ему нужен
 * `tabIndex={-1}`, чтобы принять фокус, когда внутри ещё нечего фокусировать).
 */
export function useDialog(
  onClose: () => void,
  open = true,
): React.RefObject<HTMLDivElement | null> {
  const ref = useRef<HTMLDivElement | null>(null);
  useEscape(onClose, open);

  useEffect(() => {
    const node = ref.current;
    if (!open || !node) return undefined;
    const opener = document.activeElement as HTMLElement | null;
    (focusable(node)[0] ?? node).focus();

    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return;
      const stops = focusable(node);
      if (stops.length === 0) return;
      const [first] = stops;
      const last = stops[stops.length - 1];
      // Цикл замыкается руками: без этого Tab с последнего элемента уходит в
      // страницу под наложением, которую наложение как раз и закрывает.
      const leavingForward = !e.shiftKey && document.activeElement === last;
      const leavingBack = e.shiftKey && document.activeElement === first;
      if (!leavingForward && !leavingBack) return;
      e.preventDefault();
      (e.shiftKey ? last : first).focus();
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      opener?.focus?.();
    };
  }, [open]);

  return ref;
}
