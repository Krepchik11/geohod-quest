'use client';

import React, { useState } from 'react';

interface Props {
  onConfirm: (note?: string) => void;
  allowNote?: boolean;
  buttonText?: string;
  description?: string;
  hasNavigator?: boolean;
  onNavigator?: () => void;
}

// Focused <80LOC: uniform physical confirm (first_screen, task_no, terminal). Note only if allow. Parent owns append/claim/advance.
export function PhysicalConfirmButton({
  onConfirm,
  allowNote = false,
  buttonText = 'Подтвердить',
  description,
  hasNavigator,
  onNavigator,
}: Props) {
  const [note, setNote] = useState('');
  return (
    <div>
      {description && <div className="mb-1 text-[10px] text-zinc-500">{description}</div>}
      {allowNote && (
        <input
          className="mb-2 w-full border-b text-xs"
          placeholder="Note (optional)"
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
      )}
      <button
        onClick={() => {
          onConfirm(allowNote && note ? note : undefined);
          if (allowNote) setNote('');
        }}
        className="rounded bg-black px-4 py-2 text-sm text-white"
      >
        {buttonText}
      </button>
      {hasNavigator && onNavigator && (
        <button onClick={onNavigator} className="ml-2 text-xs underline">
          🗺️ Navigator
        </button>
      )}
    </div>
  );
}
