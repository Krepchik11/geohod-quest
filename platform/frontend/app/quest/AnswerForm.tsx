'use client';

import React, { useState } from 'react';

interface Props {
  questionPrompt?: string | null;
  buttonText?: string;
  onSubmit: (value: string) => void; // parent does isAnswerCorrect + append + (if !correct && hint setPopup ONLY here) + claim/advance
  disabled?: boolean;
}

// Focused: controlled input + submit. Calls imported isAnswerCorrect. Parent (AnswerTaskView/client) wires the if(!correct && hint) setPopup.
export function AnswerForm({ questionPrompt, buttonText = 'Ответить', onSubmit, disabled }: Props) {
  const [value, setValue] = useState('');
  const handle = () => {
    if (!value.trim() || disabled) return;
    onSubmit(value);
    setValue('');
  };
  return (
    <div>
      {questionPrompt && <div className="mb-1 text-sm">{questionPrompt}</div>}
      <input
        className="w-full rounded border p-2 text-sm"
        placeholder="Ваш ответ"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && handle()}
        disabled={disabled}
      />
      <button
        onClick={handle}
        disabled={disabled || !value.trim()}
        className="mt-2 rounded bg-emerald-600 px-3 py-1 text-sm text-white disabled:opacity-50"
      >
        {buttonText}
      </button>
    </div>
  );
}
