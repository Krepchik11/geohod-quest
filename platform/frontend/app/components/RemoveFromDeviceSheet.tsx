'use client';

import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { removeBlock, removeDownloadedQuest, type RemoveBlock } from '../../lib/download';
import { Button } from './ui';
import { toast } from './Toaster';

/**
 * «Удалить с устройства» for a downloaded quest (store_my_quests). Whether the
 * quest may go is lib/download's call (removeBlock — never while an attempt is
 * running); the sheet only says so. Portal to <body>, like PurchaseSheet: the
 * card's :hover transform would otherwise contain this fixed overlay.
 */
export default function RemoveFromDeviceSheet({
  questId,
  name,
  onClose,
  onRemoved,
}: {
  questId: string;
  name: string;
  onClose: () => void;
  onRemoved: () => void;
}) {
  const [block, setBlock] = useState<RemoveBlock | null | 'checking'>('checking');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    removeBlock(questId).then(
      (b) => {
        if (!cancelled) setBlock(b);
      },
      () => {
        if (!cancelled) setBlock(null); // storage unreadable — removal re-checks anyway
      },
    );
    return () => {
      cancelled = true;
    };
  }, [questId]);

  const remove = async () => {
    setBusy(true);
    try {
      await removeDownloadedQuest(questId);
      onRemoved();
    } catch {
      setBusy(false);
      toast('Не удалось удалить квест с устройства');
    }
  };

  // The check is a local read (milliseconds): show the sheet with its answer,
  // not a confirmation that turns into a refusal under the finger.
  if (block === 'checking') return null;

  return createPortal(
    <div className="sheet__ovl" onClick={busy ? undefined : onClose}>
      <div className="sheet rm-sheet" role="dialog" aria-label="Удалить с устройства" onClick={(e) => e.stopPropagation()}>
        <span className="sheet__grip" aria-hidden />
        {block === 'in-progress' ? (
          <>
            <h3 className="psheet__title">Квест уже начат</h3>
            <p className="rm-sheet__text">
              Прогресс привязан к скачанной версии квеста. Удалить его с устройства можно после прохождения.
            </p>
            <div className="rm-sheet__actions">
              <Button variant="quiet" size="md" onClick={onClose}>Понятно</Button>
            </div>
          </>
        ) : (
          <>
            <h3 className="psheet__title">Удалить с устройства?</h3>
            <p className="rm-sheet__text">
              Квест «{name}» перестанет открываться без интернета. Доступ, прогресс и монеты сохранятся — скачать
              снова можно в любой момент.
            </p>
            <div className="rm-sheet__actions">
              <Button variant="destructive" size="md" onClick={() => void remove()} disabled={busy}>
                Удалить
              </Button>
              <Button variant="quiet" size="md" onClick={onClose} disabled={busy}>Отмена</Button>
            </div>
          </>
        )}
      </div>
    </div>,
    document.body,
  );
}
