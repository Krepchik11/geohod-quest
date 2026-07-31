'use client';

import React, { useEffect, useEffectEvent, useRef, useState } from 'react';
import { beginCropFromFile, beginCropFromValue, commitCrop, sessionRect, type CropSession } from '../../lib/image-authoring';
import type { DecodedImage } from '../../lib/image-file';
import { COVER_IMAGE_MAX_BYTES, byteBudgetLabel, clampCropRect, type CropRect } from '../../lib/image-crop';
import type { CtorImageValue, CtorQuestMeta, GateField } from '../../lib/constructor-model';

/**
 * Shared workspace controls: сначала оформительские примитивы
 * (design/ctor2/page-editor.jsx), ниже — контролы, знающие про модель квеста
 * (см. «Контролы, привязанные к модели»).
 */

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

/**
 * Атрибут-якорь для §9.2 «Исправить →». Единственный способ объявить якорь:
 * поле проходит через {@link GateField}, поэтому переименование в union ломает
 * сборку, а не тихо отключает подсветку.
 */
export function gateAnchor(field: GateField | undefined): { 'data-gate-field'?: GateField } {
  return { 'data-gate-field': field };
}

export function WspBlock({ title, aside, gateField, children }: { title: string; aside?: string; gateField?: GateField; children: React.ReactNode }) {
  return (
    <div className="ed-block" {...gateAnchor(gateField)}>
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
 * поэтому геометрия из lib/image-crop покрыта node-тестами. Открывается и на
 * уже загруженном изображении — тогда стартовая рамка возвращает автора ровно
 * в тот кадр, который он выбрал раньше.
 */
function CropModal({ dec, initialRect, onConfirm, onCancel }: {
  dec: DecodedImage;
  initialRect: CropRect;
  onConfirm: (rect: CropRect) => void;
  onCancel: () => void;
}) {
  const [rect, setRect] = useState<CropRect>(initialRect);
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

  // Кадрирование открывается кликом по ЛЮБОМУ изображению — выход должен быть
  // один и всегда доступный, модалка при этом ничего не фокусирует.
  useEscape(onCancel);

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
        <p className="crop-note">Рамка 4:3 — ровно так изображение увидят в квесте и в магазине. Потяните его внутри рамки, лишнее будет обрезано.</p>
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
            src={dec.src}
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
 * Зона изображения. Контракт один для всех изображений конструктора: автор
 * выбирает рамку 4:3, зона показывает результат в тех же 4:3 — так же, как его
 * увидят в квесте и в магазине. Исходник (несрезанный) лежит рядом с кадром,
 * поэтому клик по готовому изображению ОТКРЫВАЕТ КАДР ЗАНОВО, а не требует
 * новый файл. Сама последовательность загрузок — в lib/image-authoring.
 */
export function ImageZone({ value, label, required, width, compact, maxBytes, onChange }: {
  value: CtorImageValue;
  label: string;
  required?: boolean;
  width?: number;
  /** Узкий вариант зоны для тесных строк: свой размер и без подсказки формата. */
  compact?: boolean;
  /** Бюджет кадра в байтах: роль изображения задаёт его явно (см. lib/image-crop). */
  maxBytes: number;
  onChange: (value: CtorImageValue) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [session, setSession] = useState<CropSession | null>(null);
  const src = value.url;

  const run = async (work: () => Promise<void>) => {
    if (busy) return;
    setError(null);
    setBusy(true);
    try {
      await work();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const pickFile = (file: File | undefined) => {
    if (!file) return;
    void run(async () => setSession(await beginCropFromFile(file)));
  };

  const activate = () => {
    if (!src) {
      inputRef.current?.click();
      return;
    }
    void run(async () => setSession(await beginCropFromValue(value)));
  };

  const confirmCrop = (open: CropSession, rect: CropRect) => {
    setSession(null);
    void run(async () => onChange(await commitCrop(open, rect, maxBytes)));
  };

  // Что сделает клик — говорит сама зона, и глазами (title), и озвучкой
  // (aria-label). Иначе про повторное кадрирование знает только тот блок,
  // который не забыл написать это прозой рядом.
  const action = `${src ? 'Изменить кадрирование' : 'Загрузить изображение'}: ${label}`;
  return (
    <div
      className={'comic-zone' + (src ? ' filled' : '') + (required ? ' req' : '') + (compact ? ' comic-zone--compact' : '')}
      style={width ? { width } : undefined}
      role="button"
      tabIndex={0}
      aria-label={action}
      title={action}
      onClick={activate}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); activate(); } }}
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => { e.preventDefault(); pickFile(e.dataTransfer.files?.[0]); }}
    >
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        style={{ display: 'none' }}
        onChange={(e) => { pickFile(e.target.files?.[0]); e.target.value = ''; }}
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
            onClick={(e) => { e.stopPropagation(); onChange({ url: null, origin: null }); }}
          >✕</button>
        </>
      ) : (
        <>
          <b>{label}</b>
          <span className="zone-hint">{`PNG/JPG, кадр 4:3, до ${byteBudgetLabel(maxBytes)}`}</span>
        </>
      )}
      {/* Одно место для обоих состояний зоны — пустой и заполненной. */}
      {busy || error ? (
        <span className={'zone-msg' + (error ? ' zone-msg--error' : '')}>{error || 'Загрузка…'}</span>
      ) : null}
      {session ? (
        <CropModal
          dec={session.decoded}
          initialRect={sessionRect(session)}
          onCancel={() => setSession(null)}
          onConfirm={(rect) => confirmCrop(session, rect)}
        />
      ) : null}
    </div>
  );
}

/* ---------- Контролы, привязанные к модели квеста ---------- */

/**
 * Обложка квеста как контрол: она живёт в мете (`cover` + `coverOrigin`), а
 * правится из двух мест — из настроек квеста и с «Первого экрана», где она и
 * есть содержимое страницы. Роль объявлена здесь один раз, поэтому оба места
 * правят одно поле одинаково.
 */
export function QuestCoverZone({ meta, onMeta, width, compact }: {
  meta: CtorQuestMeta;
  onMeta: (meta: CtorQuestMeta) => void;
  width?: number;
  compact?: boolean;
}) {
  return (
    <ImageZone
      value={{ url: meta.cover, origin: meta.coverOrigin }}
      label="обложка"
      width={width}
      compact={compact}
      maxBytes={COVER_IMAGE_MAX_BYTES}
      onChange={(v) => onMeta({ ...meta, cover: v.url, coverOrigin: v.origin })}
    />
  );
}
