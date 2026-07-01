'use client';

import { useEffect, useState } from 'react';
import { installState, isIosSafari, isStandalone, type InstallState } from '../../lib/install';

/** The non-standard Chromium `beforeinstallprompt` event we capture to drive install. */
interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

function readStandalone(): boolean {
  return isStandalone({
    displayModeStandalone: window.matchMedia?.('(display-mode: standalone)').matches ?? false,
    navigatorStandalone: (window.navigator as Navigator & { standalone?: boolean }).standalone,
  });
}

/**
 * «Установить приложение» affordance on /my-quests (the PWA `start_url` — the
 * home-screen target). Chromium fires `beforeinstallprompt`, which we capture to
 * show a button that triggers the native install; iOS Safari has no such API, so
 * it gets a manual «Поделиться → На экран „Домой"» sheet. An already-installed
 * (standalone) app renders nothing. Installing is what makes offline play feel
 * like a real app — the downloaded bundles are already there.
 */
export default function InstallPrompt() {
  const [deferred, setDeferred] = useState<BeforeInstallPromptEvent | null>(null);
  const [state, setState] = useState<InstallState>('hidden');
  const [sheetOpen, setSheetOpen] = useState(false);

  useEffect(() => {
    const recompute = (canPrompt: boolean) =>
      setState(
        installState({
          standalone: readStandalone(),
          canPrompt,
          iosSafari: isIosSafari(window.navigator.userAgent),
        }),
      );

    const onPrompt = (e: Event) => {
      e.preventDefault(); // suppress the mini-infobar; we drive install from our own button
      setDeferred(e as BeforeInstallPromptEvent);
      recompute(true);
    };
    const onInstalled = () => {
      setDeferred(null);
      setSheetOpen(false);
      setState('installed');
    };

    window.addEventListener('beforeinstallprompt', onPrompt);
    window.addEventListener('appinstalled', onInstalled);
    recompute(false); // initial: covers already-installed + iOS Safari (no prompt event fires)

    return () => {
      window.removeEventListener('beforeinstallprompt', onPrompt);
      window.removeEventListener('appinstalled', onInstalled);
    };
  }, []);

  const install = async () => {
    if (!deferred) return;
    await deferred.prompt(); // single-use; `appinstalled` finalizes the success path
    setDeferred(null);
    setState('hidden');
  };

  // Chromium fires the native prompt; iOS Safari has no API, so open the manual sheet.
  const onCta = () => {
    if (state === 'installable') void install();
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
