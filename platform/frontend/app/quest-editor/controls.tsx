'use client';

import React, { useEffect, useRef, useState } from 'react';
import { fileToImageDataUrl } from '../../lib/image-file';

/** Shared workspace controls (design/ctor2/page-editor.jsx primitives). */

export function WspToggle({ on, onClick, label }: { on: boolean; onClick: () => void; label: string }) {
  return (
    <button
      type="button"
      className={'adm-toggle' + (on ? ' on' : '')}
      style={{ background: 'none', border: 'none', padding: 0 }}
      role="switch"
      aria-checked={on}
      onClick={onClick}
    >
      <span className="tk" />{label}
    </button>
  );
}

export function WspBlock({ title, aside, children }: { title: string; aside?: string; children: React.ReactNode }) {
  return (
    <div className="ed-block">
      <h4>{title}{aside ? <span className="opt">{aside}</span> : null}</h4>
      {children}
    </div>
  );
}

/** Двухтактное удаление: первый клик взводит, второй (в течение 2.6 с) подтверждает. */
export function WspDanger({ label, confirmLabel, onConfirm }: { label: string; confirmLabel: string; onConfirm: () => void }) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return undefined;
    const t = setTimeout(() => setArmed(false), 2600);
    return () => clearTimeout(t);
  }, [armed]);
  return (
    <button
      className="adm-btn adm-btn--danger adm-btn--sm"
      type="button"
      onClick={() => {
        if (armed) {
          onConfirm();
          setArmed(false);
        } else {
          setArmed(true);
        }
      }}
    >
      {armed ? confirmLabel : label}
    </button>
  );
}

/**
 * Зона изображения с настоящей загрузкой файла (downscale → data URL).
 * Пустая зона открывает выбор файла; заполненная показывает картинку и ✕.
 */
export function ImageZone({ src, label, hint, required, width, onChange }: {
  src: string | null | undefined;
  label: string;
  hint?: string;
  required?: boolean;
  width?: number;
  onChange: (src: string | null) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);

  const pickFile = async (file: File | undefined) => {
    if (!file) return;
    try {
      setError(null);
      onChange(await fileToImageDataUrl(file));
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <div
      className={'comic-zone' + (src ? ' filled' : '') + (required ? ' req' : '')}
      style={width ? { width } : undefined}
      role="button"
      tabIndex={0}
      aria-label={`Загрузить изображение: ${label}`}
      onClick={() => { if (!src) inputRef.current?.click(); }}
      onKeyDown={(e) => { if (!src && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); inputRef.current?.click(); } }}
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => { e.preventDefault(); void pickFile(e.dataTransfer.files?.[0]); }}
    >
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        style={{ display: 'none' }}
        onChange={(e) => { void pickFile(e.target.files?.[0]); e.target.value = ''; }}
      />
      {src ? (
        <>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={src} alt={label} />
          <span className="tag">{label}</span>
          <button
            className="rm"
            type="button"
            aria-label="Убрать изображение"
            onClick={(e) => { e.stopPropagation(); onChange(null); }}
          >✕</button>
        </>
      ) : (
        <>
          <b>{label}</b>
          {error ? <span style={{ color: 'var(--pink)', fontWeight: 600 }}>{error}</span> : (hint || 'PNG/JPG до 1 МБ')}
        </>
      )}
    </div>
  );
}
