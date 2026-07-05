'use client';

import React, { useState } from 'react';
import { useInstall } from './useInstall';

/**
 * §5 per-quest install button — rendered on quest-scoped pages (the product
 * page owned card), where <link rel="manifest"> points at THIS quest's
 * manifest, so the Chromium prompt installs the quest as its own app.
 * iOS Safari has no prompt API → instruction sheet. Hidden when already
 * running standalone or no install path exists.
 */
export default function InstallQuestButton({ cover }: { cover: string | null }) {
  const { state, prompt } = useInstall();
  const [sheetOpen, setSheetOpen] = useState(false);

  if (state !== 'installable' && state !== 'ios-instructions') return null;

  return (
    <>
      <button
        id="install"
        className="btn btn--secondary btn--md"
        type="button"
        onClick={() => (state === 'installable' ? void prompt() : setSheetOpen(true))}
      >
        ⊕ Установить на телефон
      </button>
      <p className="qp-install-note">Появится на экране «Домой» с названием и обложкой квеста и откроется сразу в игру.</p>

      {sheetOpen && (
        <div className="psheet__ovl" onClick={() => setSheetOpen(false)}>
          <div className="psheet qp-ios-sheet" role="dialog" aria-label="Установка квеста" onClick={(e) => e.stopPropagation()}>
            <span className="psheet__grabber" aria-hidden />
            <div className="qp-ios-sheet__head">
              {cover && <span className="qp-ios-sheet__thumb" style={{ backgroundImage: `url(${cover})` }} />}
              <b>Квест — на экран «Домой»</b>
            </div>
            <p className="qp-ios-sheet__steps">
              1. Нажмите <b>Поделиться</b> в панели Safari<br />
              2. Выберите <b>На экран «Домой»</b><br />
              3. Иконка квеста откроет игру сразу — даже офлайн
            </p>
            <button className="btn btn--quiet btn--sm" type="button" onClick={() => setSheetOpen(false)}>Понятно</button>
          </div>
        </div>
      )}
    </>
  );
}
