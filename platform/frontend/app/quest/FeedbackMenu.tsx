'use client';

import React, { useState } from 'react';

interface Props {
  onReport: (note: string) => void; // parent appends feedback_reported with step + note
}

// Focused global any-page: "Оставить отзыв" -> prompt/note -> append fact (no coins, any step).
export function FeedbackMenu({ onReport }: Props) {
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState('');
  return (
    <div className="mt-4 border-t pt-3 text-xs">
      <button onClick={() => setOpen(!open)} className="underline">
        Оставить отзыв
      </button>
      {open && (
        <div className="mt-1 flex gap-1">
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="note (attaches to current step)"
            className="flex-1 border-b bg-transparent text-xs"
          />
          <button
            onClick={() => {
              const n = note.trim();
              if (n) onReport(n);
              setNote('');
              setOpen(false);
            }}
            className="text-xs underline"
          >
            Send
          </button>
        </div>
      )}
    </div>
  );
}
