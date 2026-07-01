/**
 * PWA install-affordance logic (pure). Decides whether to offer the native
 * install prompt, iOS "Add to Home Screen" instructions, or nothing — kept out
 * of the component so the platform branching is unit-testable.
 */
import { describe, expect, it } from 'vitest';
import { installState, isIosSafari, isStandalone } from '../install';

const IPHONE_SAFARI =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1';
const IPHONE_CHROME =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/124.0 Mobile/15E148 Safari/604.1';
const ANDROID_CHROME =
  'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Mobile Safari/537.36';
const DESKTOP_CHROME =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

describe('isIosSafari', () => {
  it('is true for iPhone Safari (the only engine with manual A2HS)', () => {
    expect(isIosSafari(IPHONE_SAFARI)).toBe(true);
  });
  it('is false for iOS Chrome/Firefox (CriOS/FxiOS) — A2HS guidance differs', () => {
    expect(isIosSafari(IPHONE_CHROME)).toBe(false);
  });
  it('is false for Android and desktop', () => {
    expect(isIosSafari(ANDROID_CHROME)).toBe(false);
    expect(isIosSafari(DESKTOP_CHROME)).toBe(false);
  });
});

describe('isStandalone', () => {
  it('is true when the display-mode media query matches (installed PWA)', () => {
    expect(isStandalone({ displayModeStandalone: true })).toBe(true);
  });
  it('is true via the legacy iOS navigator.standalone flag', () => {
    expect(isStandalone({ displayModeStandalone: false, navigatorStandalone: true })).toBe(true);
  });
  it('is false in a normal browser tab', () => {
    expect(isStandalone({ displayModeStandalone: false, navigatorStandalone: false })).toBe(false);
    expect(isStandalone({ displayModeStandalone: false })).toBe(false);
  });
});

describe('installState', () => {
  it('hides itself once the app runs standalone (already installed)', () => {
    expect(installState({ standalone: true, canPrompt: true, iosSafari: true })).toBe('installed');
  });
  it('offers the native prompt when one was captured', () => {
    expect(installState({ standalone: false, canPrompt: true, iosSafari: false })).toBe('installable');
  });
  it('falls back to iOS instructions when no prompt is available on iOS Safari', () => {
    expect(installState({ standalone: false, canPrompt: false, iosSafari: true })).toBe('ios-instructions');
  });
  it('shows nothing on a platform with neither a prompt nor iOS A2HS', () => {
    expect(installState({ standalone: false, canPrompt: false, iosSafari: false })).toBe('hidden');
  });
});
