'use client';

import React, { useEffect, useRef, useState } from 'react';
import { cropToStepImage, decodeImageFile, fileToImageBlob, type DecodedImage } from '../../lib/image-file';
import { clampCropRect, largestAspectRect, matchesAspect, type CropRect } from '../../lib/image-crop';
import { api } from '../../lib/api';
import type { GateField } from '../../lib/constructor-model';

/** Shared workspace controls (design/ctor2/page-editor.jsx primitives). */

export function WspToggle({ on, onClick, label, ariaLabel, disabled }: { on: boolean; onClick: () => void; label?: string; ariaLabel?: string; disabled?: boolean }) {
  return (
    <button
      type="button"
      className={'adm-toggle' + (on ? ' on' : '')}
      style={{ background: 'none', border: 'none', padding: 0 }}
      role="switch"
      aria-checked={on}
      aria-label={ariaLabel}
      onClick={onClick}
      disabled={disabled}
    >
      <span className="tk" />{label}
    </button>
  );
}

export function WspBlock({ title, aside, gateField, children }: { title: string; aside?: string; gateField?: GateField; children: React.ReactNode }) {
  return (
    <div className="ed-block" data-gate-field={gateField}>
      <h4>{title}{aside ? <span className="opt">{aside}</span> : null}</h4>
      {children}
    </div>
  );
}

/**
 * §9.2 «Исправить →»: доскроллить до элемента с этим gateField и мигнуть им.
 * Якорь — любой `data-gate-field` (блок {@link WspBlock} или отдельный контрол),
 * запрос по DOM, а не по рефам: объявление якоря остаётся при самой разметке.
 * Хук общий, иначе панель, где его забыли, молча не подсвечивает ничего.
 */
export function useGateHighlight(highlight: { field?: GateField } | null | undefined): void {
  useEffect(() => {
    if (!highlight?.field) return undefined;
    const el = document.querySelector(`[data-gate-field="${highlight.field}"]`);
    if (!(el instanceof HTMLElement)) return undefined;
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el.classList.add('gate-flash');
    const t = setTimeout(() => el.classList.remove('gate-flash'), 2400);
    return () => clearTimeout(t);
  }, [highlight]);
}

/** Красная строка «публикация будет заблокирована» под проблемным контролом. */
export function GateNote({ children }: { children: React.ReactNode }) {
  return (
    <p style={{ margin: 0, fontSize: 12.5, color: 'var(--red)', fontWeight: 600 }}>
      ✗ {children} — публикация будет заблокирована.
    </p>
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
      className="btn btn--danger btn--sm"
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
 * Кадрирование под 4:3: рамка фиксирована, автор перетаскивает изображение
 * вдоль свободной оси. Работает в исходных координатах картинки (CropRect),
 * поэтому геометрия из lib/image-crop покрыта node-тестами.
 */
function CropModal({ dec, onConfirm, onCancel }: {
  dec: DecodedImage;
  onConfirm: (rect: CropRect) => void;
  onCancel: () => void;
}) {
  const [rect, setRect] = useState<CropRect>(() => largestAspectRect(dec.width, dec.height));
  const viewRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; y: number; rect: CropRect } | null>(null);
  // Measured frame width — the ref is null on first render and the frame is
  // responsive, so track it with a ResizeObserver instead of reading ad hoc.
  const [viewW, setViewW] = useState(0);
  useEffect(() => {
    const el = viewRef.current;
    if (!el) return undefined;
    setViewW(el.clientWidth);
    const ro = new ResizeObserver(() => setViewW(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // view px → source px: the frame always shows the full crop rect width.
  const scale = (viewW || 400) / rect.width;

  const onPointerDown = (e: React.PointerEvent) => {
    drag.current = { x: e.clientX, y: e.clientY, rect };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!drag.current) return;
    setRect(clampCropRect({
      ...drag.current.rect,
      x: drag.current.rect.x - (e.clientX - drag.current.x) / scale,
      y: drag.current.rect.y - (e.clientY - drag.current.y) / scale,
    }, dec.width, dec.height));
  };
  const onPointerUp = () => { drag.current = null; };

  return (
    // stopPropagation: модалка живёт внутри кликабельной зоны — клики не должны
    // повторно открывать выбор файла.
    <div className="crop-overlay" role="dialog" aria-modal="true" aria-label="Кадрирование изображения 4:3" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
      <div className="crop-card">
        <h4>Кадрирование 4:3</h4>
        <p className="crop-note">Изображение не 4:3 — потяните его внутри рамки, лишнее будет обрезано.</p>
        <div
          ref={viewRef}
          className="crop-view"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={dec.dataUrl}
            alt=""
            draggable={false}
            style={{
              width: dec.width * scale,
              height: dec.height * scale,
              transform: `translate(${-rect.x * scale}px, ${-rect.y * scale}px)`,
            }}
          />
        </div>
        <div className="crop-actions">
          <button className="btn btn--secondary btn--sm" type="button" onClick={onCancel}>Отмена</button>
          <button className="btn btn--sm" type="button" onClick={() => onConfirm(rect)}>Обрезать и загрузить</button>
        </div>
      </div>
    </div>
  );
}

/**
 * Зона изображения с настоящей загрузкой файла (downscale → upload в R2 → URL).
 * Пустая зона открывает выбор файла; заполненная показывает картинку и ✕.
 * С `aspect43` действует контракт страницы: строго 4:3 (иначе — кадрирование)
 * и сжатие до 100 КБ перед загрузкой.
 */
export function ImageZone({ src, label, hint, required, width, aspect43, onChange }: {
  src: string | null | undefined;
  label: string;
  hint?: string;
  required?: boolean;
  width?: number;
  aspect43?: boolean;
  onChange: (src: string | null) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [pendingCrop, setPendingCrop] = useState<DecodedImage | null>(null);

  const upload = async (work: () => Promise<Blob>) => {
    setError(null);
    setUploading(true);
    try {
      const blob = await work();
      const { url } = await api.uploadMedia(blob);
      onChange(url);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setUploading(false);
    }
  };

  const pickFile = async (file: File | undefined) => {
    if (!file) return;
    if (!aspect43) {
      // Обложка и прочие свободные зоны: старый путь (downscale → upload).
      await upload(() => fileToImageBlob(file));
      return;
    }
    setError(null);
    try {
      const dec = await decodeImageFile(file);
      if (matchesAspect(dec.width, dec.height)) {
        await upload(() => cropToStepImage(dec.img, { x: 0, y: 0, width: dec.width, height: dec.height }));
      } else {
        setPendingCrop(dec); // не 4:3 — сначала кадрирование
      }
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
            <span style={{ color: 'var(--text)', fontWeight: 600 }}>Загрузка…</span>
          ) : error ? (
            <span style={{ color: 'var(--red)', fontWeight: 600 }}>{error}</span>
          ) : (
            hint || (aspect43 ? 'PNG/JPG, 4:3, до 100 КБ' : 'PNG/JPG до 1 МБ')
          )}
        </>
      )}
      {pendingCrop ? (
        <CropModal
          dec={pendingCrop}
          onCancel={() => setPendingCrop(null)}
          onConfirm={(rect) => {
            const dec = pendingCrop;
            setPendingCrop(null);
            void upload(() => cropToStepImage(dec.img, rect));
          }}
        />
      ) : null}
    </div>
  );
}
