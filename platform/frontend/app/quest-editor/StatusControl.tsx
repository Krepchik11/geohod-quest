'use client';

import React, { useEffect, useState } from 'react';
import type { ConstructorQuestWire, CtorStatus } from '../../lib/api';
import { Button } from '../components/ui';
import { useDialog } from '../components/useDialog';

/**
 * §9.1 status control — a status chip opening a menu of NAMED transitions,
 * replacing the raw <select>.
 *
 * Honesty rules:
 * - a quest with no published snapshot cannot be flipped to test/published (the
 *   backend coherence guard would 400), so those actions route into the publish
 *   panel instead — the guard is unreachable from this UI by construction;
 * - «Снять с публикации…» is destructive and confirms with real consequences,
 *   including the honest buyers count from the wire (grants survive delisting).
 */
export interface StatusControlProps {
  quest: ConstructorQuestWire;
  onStatusChange: (status: CtorStatus) => void;
  /** Route into the editor's publish panel (gated publication path). */
  onOpenPublish: () => void;
}

const CHIP: Record<CtorStatus, { label: string; className: string }> = {
  published: { label: 'Опубликован', className: 'status-chip--published' },
  test: { label: 'Тест', className: 'status-chip--test' },
  draft: { label: 'Проект', className: 'status-chip--draft' },
};

type Action = {
  key: string;
  title: string;
  subtitle?: string;
  danger?: boolean;
  run: 'direct-test' | 'direct-published' | 'publish-panel' | 'confirm-unpublish' | 'direct-draft';
};

/** Named transitions offered from each status (pure — unit-testable). */
export function actionsFor(status: CtorStatus, hasSnapshot: boolean): Action[] {
  if (status === 'published') {
    return [
      { key: 'to-test', title: 'Перевести в «Тест»', subtitle: 'скроется из магазина, останется тестерам', run: 'direct-test' },
      { key: 'unpublish', title: 'Снять с публикации…', subtitle: 'с подтверждением последствий', danger: true, run: 'confirm-unpublish' },
    ];
  }
  if (status === 'test') {
    return [
      { key: 'to-published', title: 'Опубликовать', subtitle: 'версия уже собрана — квест вернётся в магазин', run: hasSnapshot ? 'direct-published' : 'publish-panel' },
      { key: 'to-draft', title: 'Перевести в «Проект»', subtitle: 'скроется и от тестеров', run: 'direct-draft' },
    ];
  }
  return [
    { key: 'to-test', title: 'Перевести в «Тест»', subtitle: hasSnapshot ? 'станет доступен тестерам' : 'через панель публикации (гейты)', run: hasSnapshot ? 'direct-test' : 'publish-panel' },
    { key: 'to-published', title: 'Опубликовать', subtitle: hasSnapshot ? 'квест вернётся в магазин' : 'через панель публикации (гейты)', run: hasSnapshot ? 'direct-published' : 'publish-panel' },
  ];
}

export default function StatusControl({ quest, onStatusChange, onOpenPublish }: StatusControlProps) {
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const dialog = useDialog(() => setConfirming(false), confirming);
  const chip = CHIP[quest.status];
  const hasSnapshot = quest.published_version != null;

  useEffect(() => {
    if (!open) return;
    const onDoc = () => setOpen(false);
    document.addEventListener('click', onDoc);
    return () => document.removeEventListener('click', onDoc);
  }, [open]);

  const runAction = (a: Action) => {
    setOpen(false);
    switch (a.run) {
      case 'direct-test': return onStatusChange('test');
      case 'direct-published': return onStatusChange('published');
      case 'direct-draft': return onStatusChange('draft');
      case 'publish-panel': return onOpenPublish();
      case 'confirm-unpublish': return setConfirming(true);
    }
  };

  return (
    <div className="status-ctl" onClick={(e) => e.stopPropagation()}>
      <button
        type="button"
        className={`status-chip ${chip.className}`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="status-chip__dot" aria-hidden />
        {chip.label}
        <span className="status-chip__caret" aria-hidden>▾</span>
      </button>

      {open && (
        <div className="status-menu" role="menu">
          <span className="status-menu__head">Сменить статус</span>
          {actionsFor(quest.status, hasSnapshot).map((a) => (
            <button
              key={a.key}
              type="button"
              role="menuitem"
              className={`status-menu__item ${a.danger ? 'is-danger' : ''}`}
              onClick={() => runAction(a)}
            >
              <b>{a.title}</b>
              {a.subtitle && <span>{a.subtitle}</span>}
            </button>
          ))}
          <span className="status-menu__note">
            Публикация новой версии — только через панель публикации в редакторе (гейты).
          </span>
        </div>
      )}

      {confirming && (
        <div className="status-confirm__ovl" onClick={() => setConfirming(false)}>
          <div ref={dialog} tabIndex={-1} className="status-confirm" role="alertdialog" aria-modal="true" aria-label={`Снять «${quest.name}» с публикации?`} onClick={(e) => e.stopPropagation()}>
            <b className="status-confirm__title">Снять «{quest.name}» с публикации?</b>
            <div className="status-confirm__list">
              <span><i className="is-bad">✕</i>Квест исчезнет из магазина</span>
              <span><i className="is-good">✓</i>У {quest.buyers} купивших доступ и прогресс сохранятся</span>
              <span><i className="is-good">✓</i>Версии не удаляются — можно опубликовать снова</span>
            </div>
            <div className="status-confirm__row">
              <Button
                variant="destructive"
                size="md"
                className="status-confirm__go"
                onClick={() => {
                  setConfirming(false);
                  onStatusChange('draft');
                }}
              >
                Снять с публикации
              </Button>
              <Button variant="quiet" size="md" onClick={() => setConfirming(false)}>Отмена</Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
