'use client';

import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { TPL_BY_KEY, type CtorTemplate } from '../../lib/constructor-model';

/* ---------- Меню «Новая страница» (флаг ctor_page_menu) ---------- */

const ICON_PATHS: Record<CtorTemplate, React.ReactNode> = {
  continue: <><path d="M4 6h11M4 10h14M4 14h9" /><path d="M15 15l4 3-4 3" /></>,
  task_answer: <><rect x="3" y="14" width="18" height="6" rx="2" /><path d="M9.5 6.5a2.5 2.5 0 1 1 3.3 2.4c-.5.2-.8.6-.8 1.1V11" /></>,
  task_no: <><path d="M12 21s-6-5.6-6-10.5a6 6 0 0 1 12 0C18 15.4 12 21 12 21z" /><circle cx="12" cy="10.5" r="2.2" /></>,
  congrats: <path d="M12 3l2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.4 6.8 19.1l1-5.8L3.5 9.2l5.9-.9z" />,
  start: <><rect x="4" y="3" width="16" height="18" rx="2" /><path d="M8 8h8M8 12h5" /></>,
  video: <><rect x="3" y="5" width="18" height="14" rx="2" /><path d="M10 9l5 3-5 3z" /></>,
  route_video: <><rect x="3" y="5" width="18" height="14" rx="2" /><path d="M10 9l5 3-5 3z" /></>,
};

function TemplateIcon({ template }: { template: CtorTemplate }) {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {ICON_PATHS[template]}
    </svg>
  );
}

/**
 * Короткое меню шаблонов у кнопки «+ Добавить страницу» и у «+» между
 * страницами ленты. Выбор — кликом, клавишами 1…N или стрелками и Enter; Esc и
 * клик мимо закрывают. Справа — превью выбранного шаблона настоящим плеером.
 * Меню фиксировано во вьюпорте (лента прокручивается и обрезала бы его) и
 * прижимается к его краям.
 */
export function PageMenu({ at, templates, where, preview, onPick, onClose }: {
  /** Левый верхний угол меню, px вьюпорта. */
  at: { x: number; y: number };
  templates: CtorTemplate[];
  /** «Встанет после страницы 12 «…»» — для выбранного пункта. */
  where: (key: CtorTemplate) => string;
  preview: (key: CtorTemplate) => React.ReactNode;
  onPick: (key: CtorTemplate) => void;
  onClose: () => void;
}) {
  const [active, setActive] = useState(0);
  const [pos, setPos] = useState(at);
  const boxRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const current = templates[Math.min(active, templates.length - 1)];

  useLayoutEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    const { width, height } = box.getBoundingClientRect();
    setPos({
      x: Math.max(8, Math.min(at.x, window.innerWidth - width - 8)),
      y: Math.max(8, Math.min(at.y, window.innerHeight - height - 8)),
    });
  }, [at]);

  useEffect(() => {
    itemRefs.current[active]?.focus({ preventScroll: true });
  }, [active]);

  useEffect(() => {
    // Клик мимо закрывает. Кнопки, открывающие меню, переключают его сами.
    const down = (e: MouseEvent) => {
      const t = e.target as Element | null;
      if (!t || boxRef.current?.contains(t) || t.closest('[data-pmenu-trigger]')) return;
      onClose();
    };
    const resize = () => onClose();
    document.addEventListener('mousedown', down);
    window.addEventListener('resize', resize);
    return () => {
      document.removeEventListener('mousedown', down);
      window.removeEventListener('resize', resize);
    };
  }, [onClose]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    const n = templates.length;
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((i) => (i + 1) % n);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((i) => (i - 1 + n) % n);
    } else if (e.key === 'Home') {
      e.preventDefault();
      setActive(0);
    } else if (e.key === 'End') {
      e.preventDefault();
      setActive(n - 1);
    } else if (/^[1-9]$/.test(e.key) && Number(e.key) <= n) {
      e.preventDefault();
      onPick(templates[Number(e.key) - 1]);
    }
  };

  return (
    <div
      ref={boxRef}
      className="wsp-pmenu"
      style={{ left: pos.x, top: pos.y }}
      role="menu"
      aria-label="Новая страница"
      onKeyDown={onKeyDown}
    >
      <div className="wsp-pmenu__list">
        <p className="wsp-pmenu__where">{where(current)}</p>
        {templates.map((key, i) => (
          <button
            key={key}
            ref={(el) => { itemRefs.current[i] = el; }}
            type="button"
            role="menuitem"
            className={'wsp-pmenu__item' + (i === active ? ' on' : '')}
            onMouseEnter={() => setActive(i)}
            onFocus={() => setActive(i)}
            onClick={() => onPick(key)}
          >
            <span className="wsp-pmenu__ic"><TemplateIcon template={key} /></span>
            <span className="wsp-pmenu__txt">
              <span className="wsp-pmenu__nm">{TPL_BY_KEY[key].name}</span>
              <span className="wsp-pmenu__ds">{TPL_BY_KEY[key].short}</span>
            </span>
            <span className="wsp-pmenu__key" aria-hidden="true">{i + 1}</span>
          </button>
        ))}
      </div>
      <div className="wsp-pmenu__prev" aria-hidden="true">
        <div className="frame">{preview(current)}</div>
        <p className="wsp-pmenu__cap">Превью «{TPL_BY_KEY[current].name}»</p>
      </div>
    </div>
  );
}
