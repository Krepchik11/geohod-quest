'use client';

import { useState } from 'react';
import { useInstall } from './useInstall';

/**
 * «Установить приложение» — the GLOBAL app install affordance (root manifest).
 * §7.3 moves the trigger into Profile; Chromium gets the captured native
 * prompt, iOS Safari a manual «Поделиться → На экран „Домой"» sheet, an
 * installed (standalone) app renders nothing. Install logic lives in the
 * shared useInstall hook (also used by the per-quest button, §5).
 */
export default function InstallPrompt() {
  const { state, prompt } = useInstall();
  const [sheetOpen, setSheetOpen] = useState(false);

  // Chromium fires the native prompt; iOS Safari has no API, so open the manual sheet.
  const onCta = () => {
    if (state === 'installable') void prompt();
    else setSheetOpen(true);
  };

  if (state !== 'installable' && state !== 'ios-instructions') return null;

  return (
    <div className="mq-install">
      <button className="btn" type="button" onClick={onCta}>
        Установить приложение
      </button>
      <span className="mq-install__hint">Добавьте на главный экран — и проходите квесты офлайн, как в обычном приложении.</span>

      {state === 'ios-instructions' && (
        <div className={`overlay${sheetOpen ? ' is-open' : ''}`} onClick={() => setSheetOpen(false)}>
          <div className="modal mq-install__sheet" onClick={(e) => e.stopPropagation()}>
            <button className="modal__close" type="button" aria-label="Закрыть" onClick={() => setSheetOpen(false)} />
            <h3>Установка на iPhone</h3>
            <ol>
              <li>Нажмите <b>Поделиться</b> в панели Safari (квадрат со стрелкой вверх).</li>
              <li>Выберите <b>«На экран Домой»</b>.</li>
              <li>Подтвердите — <b>Добавить</b>.</li>
            </ol>
            <p className="mq-install__note">После установки квесты открываются офлайн, как обычное приложение.</p>
          </div>
        </div>
      )}
    </div>
  );
}
