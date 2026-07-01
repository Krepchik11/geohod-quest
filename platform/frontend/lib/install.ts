/**
 * PWA install-affordance logic (pure, platform-branching only — no DOM access).
 *
 * The manifest makes the app installable, but discovery is the problem: Chrome/Android
 * fire `beforeinstallprompt` (we capture it and show a button); iOS Safari has no such
 * API and requires a manual «Поделиться → На экран Домой», so it needs instructions
 * instead. An already-installed (standalone) app shows neither.
 */

export type InstallState =
  /** Running as an installed PWA — offer nothing. */
  | 'installed'
  /** A `beforeinstallprompt` was captured — show the native-install button. */
  | 'installable'
  /** iOS Safari, not installed, no prompt API — show manual A2HS instructions. */
  | 'ios-instructions'
  /** No install path on this platform/state — render nothing. */
  | 'hidden';

/** iOS Safari is the only iOS engine where the manual "Add to Home Screen" flow applies. */
export function isIosSafari(ua: string): boolean {
  const isIos = /iphone|ipad|ipod/i.test(ua);
  const isWebKit = /webkit/i.test(ua);
  // iOS Chrome/Firefox/Edge/Opera (CriOS/FxiOS/EdgiOS/OPiOS) can't add to home screen the same way.
  const isOtherIosBrowser = /crios|fxios|edgios|opios/i.test(ua);
  return isIos && isWebKit && !isOtherIosBrowser;
}

/** Whether the app is already running installed (display-mode standalone, or the legacy iOS flag). */
export function isStandalone(opts: { displayModeStandalone: boolean; navigatorStandalone?: boolean }): boolean {
  return opts.displayModeStandalone || opts.navigatorStandalone === true;
}

/** Resolve which install affordance (if any) to render. */
export function installState(o: { standalone: boolean; canPrompt: boolean; iosSafari: boolean }): InstallState {
  if (o.standalone) return 'installed';
  if (o.canPrompt) return 'installable';
  if (o.iosSafari) return 'ios-instructions';
  return 'hidden';
}
