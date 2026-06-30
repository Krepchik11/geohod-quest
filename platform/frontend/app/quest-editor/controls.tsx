'use client';

import React, { useEffect, useRef, useState } from 'react';
import { fileToImageBlob } from '../../lib/image-file';
import { api } from '../../lib/api';

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
      className="btn-ui btn-ui--ghost-danger btn-ui--sm"
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
 * Зона изображения с настоящей загрузкой файла (downscale → upload в R2 → URL).
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
  const [uploading, setUploading] = useState(false);

  const pickFile = async (file: File | undefined) => {
    if (!file) return;
    setError(null);
    setUploading(true);
    try {
      // Downscale locally, then upload to the media store; store the returned URL.
      const blob = await fileToImageBlob(file);
      const { url } = await api.uploadMedia(blob);
      onChange(url);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setUploading(false);
    }
  };

  return (
    <div
      className={'comic-zone' + (src ? ' filled' : '') + (required ? ' req' : '')}
      style={width ? { width } : undefined}
      role="button"
      tabIndex={0}
      aria-label={`Загрузить изображение: ${label}`}
      onClick={() => { if (!src && !uploading) inputRef.current?.click(); }}
      onKeyDown={(e) => { if (!src && !uploading && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); inputRef.current?.click(); } }}
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => { e.preventDefault(); if (!uploading) void pickFile(e.dataTransfer.files?.[0]); }}
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
          {uploading ? (
            <span style={{ color: 'var(--navy)', fontWeight: 600 }}>Загрузка…</span>
          ) : error ? (
            <span style={{ color: 'var(--pink)', fontWeight: 600 }}>{error}</span>
          ) : (
            hint || 'PNG/JPG до 1 МБ'
          )}
        </>
      )}
    </div>
  );
}
