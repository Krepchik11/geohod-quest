'use client';

interface Props {
  show: boolean;
  cost: number;
  currentBal: number;
  onSpend: () => void;
  onCancel: () => void;
  revealText?: string;
}

// Focused modal: ONLY rendered post-wrong (from AnswerForm path in client). Spend appends hint_purchased (parent), cancel no fact. No other entry.
export function WrongHintPopup({ show, cost, currentBal, onSpend, onCancel, revealText }: Props) {
  if (!show) return null;
  const canAfford = currentBal >= cost;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={onCancel}>
      <div className="w-full max-w-xs rounded-2xl border bg-white p-5 dark:bg-zinc-900" onClick={(e) => e.stopPropagation()}>
        <div className="text-sm">Неверно. Потратить {cost} монет за подсказку?</div>
        {revealText && <div className="mt-1 text-[10px] text-zinc-500">After spend: {revealText}</div>}
        <div className="mt-4 flex gap-2">
          <button
            onClick={onSpend}
            disabled={!canAfford}
            className="rounded bg-amber-600 px-3 py-1 text-sm text-white disabled:opacity-50"
          >
            Spend {cost}
          </button>
          <button onClick={onCancel} className="rounded border px-3 py-1 text-sm">
            Cancel
          </button>
        </div>
        <div className="mt-1 text-[10px] text-zinc-500">bal: {currentBal}</div>
      </div>
    </div>
  );
}
