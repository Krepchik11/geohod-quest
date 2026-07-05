'use client';

import { useEffect, useState } from 'react';
import { installState, isIosSafari, isStandalone, type InstallState } from '../../lib/install';

/** The non-standard Chromium `beforeinstallprompt` event we capture to drive install. */
export interface BeforeInstallPromptEvent extends Event {
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
 * §5 shared install affordance (parameterized by whatever manifest the CURRENT
 * page links — the global one, or a quest-scoped one on /quest/[id]*):
 * captures `beforeinstallprompt`, tracks installed state, exposes `prompt()`.
 * The Chromium prompt always installs the app of the page's own manifest, so
 * per-quest install buttons live on quest-scoped pages by construction.
 */
export function useInstall(): { state: InstallState; prompt: () => Promise<void> } {
  const [deferred, setDeferred] = useState<BeforeInstallPromptEvent | null>(null);
  const [state, setState] = useState<InstallState>('hidden');

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
      setState('installed');
    };
    window.addEventListener('beforeinstallprompt', onPrompt);
    window.addEventListener('appinstalled', onInstalled);
    recompute(false); // initial: covers already-installed + iOS Safari
    return () => {
      window.removeEventListener('beforeinstallprompt', onPrompt);
      window.removeEventListener('appinstalled', onInstalled);
    };
  }, []);

  const prompt = async () => {
    if (!deferred) return;
    await deferred.prompt(); // single-use; `appinstalled` finalizes success
    setDeferred(null);
    setState('hidden');
  };

  return { state, prompt };
}
