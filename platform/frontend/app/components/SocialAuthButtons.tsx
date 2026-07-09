'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { api, type AuthProviders } from '../../lib/api';
import { anonymousPlayerId, type Session } from '../../lib/identity';

/**
 * Google + Telegram sign-in buttons (social-auth spec). ONE component for both
 * jobs — signing in on /auth (anonymous caller) and linking a provider from the
 * profile (logged-in caller): the API layer attaches the identity headers either
 * way, so the backend decides create-vs-link. Each button renders only when its
 * provider is configured (GET /api/auth/providers), mirroring the fail-closed
 * backend, so an unconfigured deployment shows nothing rather than a dead button.
 *
 * Both providers load their own first-party script (no bundler import) and hand us
 * an OpenID Connect **ID token** (a JWT): Google Identity Services renders the
 * official button; Telegram's `telegram-login.js` opens a login popup via
 * `Telegram.Login.auth`. We forward each ID token to the backend, which VERIFIES
 * it against the provider's JWKS before trusting anything, then store the session.
 */

/** Telegram's OIDC login library (oauth.telegram.org/js/telegram-login.js). */
const TELEGRAM_LOGIN_JS = 'https://oauth.telegram.org/js/telegram-login.js?5';

/** Load an external script once (deduped by src); resolve when ready. */
function loadScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(`script[src="${src}"]`);
    if (existing) {
      if (existing.dataset.loaded === 'true') return resolve();
      existing.addEventListener('load', () => resolve());
      existing.addEventListener('error', () => reject(new Error(`failed to load ${src}`)));
      return;
    }
    const script = document.createElement('script');
    script.src = src;
    script.async = true;
    script.addEventListener('load', () => {
      script.dataset.loaded = 'true';
      resolve();
    });
    script.addEventListener('error', () => reject(new Error(`failed to load ${src}`)));
    document.head.appendChild(script);
  });
}

// Minimal shapes of the third-party globals we touch (no @types packages).
interface GoogleIdApi {
  accounts: {
    id: {
      initialize: (cfg: { client_id: string; callback: (r: { credential: string }) => void }) => void;
      renderButton: (el: HTMLElement, opts: Record<string, unknown>) => void;
    };
  };
}
/** What `Telegram.Login.auth`'s callback receives (core.telegram.org/bots/telegram-login):
 *  a success carries the OIDC `id_token`; a cancel/failure carries `error`. */
interface TelegramAuthResult {
  id_token?: string;
  error?: string;
}
interface TelegramLoginApi {
  auth: (
    opts: { client_id: number; scope?: string[]; lang?: string; nonce?: string },
    callback: (result: TelegramAuthResult) => void,
  ) => void;
}
declare global {
  interface Window {
    google?: GoogleIdApi;
    Telegram?: { Login?: TelegramLoginApi };
  }
}

function GoogleButton({
  clientId,
  onCredential,
}: {
  clientId: string;
  onCredential: (credential: string) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  // Keep the latest callback in a ref so re-renders don't re-init the GIS button.
  // Assigned in an effect (never during render) per react-hooks/refs.
  const cb = useRef(onCredential);
  useEffect(() => {
    cb.current = onCredential;
  });

  useEffect(() => {
    let cancelled = false;
    loadScript('https://accounts.google.com/gsi/client')
      .then(() => {
        if (cancelled || !ref.current || !window.google) return;
        window.google.accounts.id.initialize({
          client_id: clientId,
          callback: (r) => cb.current(r.credential),
        });
        // Size to the container (GIS clamps to [200,400]); pill + Russian locale
        // to match the app's rounded, ru-first design.
        const width = Math.min(400, Math.max(200, ref.current.offsetWidth || 320));
        window.google.accounts.id.renderButton(ref.current, {
          theme: 'outline',
          size: 'large',
          text: 'continue_with',
          shape: 'pill',
          logo_alignment: 'center',
          locale: 'ru',
          width,
        });
      })
      .catch(() => {
        /* offline / blocked: the button simply doesn't appear */
      });
    return () => {
      cancelled = true;
    };
  }, [clientId]);

  return <div className="social-btn social-btn--google" ref={ref} />;
}

function TelegramButton({
  clientId,
  onToken,
}: {
  clientId: string;
  onToken: (idToken: string) => void;
}) {
  // Latest callback in a ref (assigned in an effect, not during render) so the
  // popup handler always calls the current onToken without re-loading the script.
  const cb = useRef(onToken);
  useEffect(() => {
    cb.current = onToken;
  });

  // Warm the library on mount; the button enables once `Telegram.Login` is ready.
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let cancelled = false;
    loadScript(TELEGRAM_LOGIN_JS)
      .then(() => {
        if (!cancelled && window.Telegram?.Login) setReady(true);
      })
      .catch(() => {
        /* offline / blocked: the button stays disabled rather than dead */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const login = useCallback(() => {
    // `Telegram.Login.auth` opens the OIDC popup and calls back with the id_token.
    // We request only `profile` (identity) — no `write` (bot-messaging) scope.
    window.Telegram?.Login?.auth(
      { client_id: Number(clientId), scope: ['profile'], lang: 'ru' },
      (result) => {
        if (result?.id_token) cb.current(result.id_token);
      },
    );
  }, [clientId]);

  return (
    <button
      type="button"
      className="social-btn social-btn--telegram"
      onClick={login}
      disabled={!ready}
      aria-busy={!ready}
    >
      <span className="social-btn__tg-glyph" aria-hidden="true" />
      Продолжить с Telegram
    </button>
  );
}

export default function SocialAuthButtons({
  onSession,
  onError,
  dividerLabel,
  exclude,
}: {
  /** Called with the fresh session after a successful sign-in / link. */
  onSession: (session: Session) => void;
  /** Optional: surface a human error (defaults to an internal inline message). */
  onError?: (message: string) => void;
  /** When set, a labelled divider renders AFTER the buttons — but only when at
   *  least one button is shown, so the "or by email" separator never appears on a
   *  deployment with no social providers. Omit in linking contexts (profile). */
  dividerLabel?: string;
  /** Provider names to NOT render (e.g. already-linked ones in the profile), so
   *  the "add a sign-in method" list only shows what can still be added. */
  exclude?: string[];
}) {
  const [providers, setProviders] = useState<AuthProviders | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .getAuthProviders()
      .then((p) => {
        if (!cancelled) setProviders(p);
      })
      .catch(() => {
        if (!cancelled) setProviders({ google_client_id: null, telegram_client_id: null });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const fail = useCallback(
    (message: string) => {
      setBusy(false);
      // Delegate to the parent when it supplied a handler (it renders the message),
      // else fall back to our own inline error — never both, or it shows twice.
      if (onError) onError(message);
      else setError(message);
    },
    [onError],
  );

  const handleGoogle = useCallback(
    (credential: string) => {
      setBusy(true);
      setError(null);
      api
        .authGoogle({ credential, player_id: anonymousPlayerId() })
        .then((s) => {
          setBusy(false);
          onSession(s);
        })
        .catch(() => fail('Не удалось войти через Google — попробуйте ещё раз.'));
    },
    [onSession, fail],
  );

  const handleTelegram = useCallback(
    (idToken: string) => {
      setBusy(true);
      setError(null);
      api
        .authTelegram({ id_token: idToken, player_id: anonymousPlayerId() })
        .then((s) => {
          setBusy(false);
          onSession(s);
        })
        .catch(() => fail('Не удалось войти через Telegram — попробуйте ещё раз.'));
    },
    [onSession, fail],
  );

  const skip = new Set(exclude ?? []);
  const showGoogle = !!providers?.google_client_id && !skip.has('google');
  const showTelegram = !!providers?.telegram_client_id && !skip.has('telegram');
  if (!showGoogle && !showTelegram) {
    // Nothing configured / already all linked (or still loading): render nothing
    // so no empty "or" divider or "add a method" block appears.
    return null;
  }

  return (
    <div className="af-social" aria-busy={busy}>
      <div className="af-social__buttons">
        {showGoogle && (
          <GoogleButton clientId={providers!.google_client_id!} onCredential={handleGoogle} />
        )}
        {showTelegram && (
          <TelegramButton clientId={providers!.telegram_client_id!} onToken={handleTelegram} />
        )}
      </div>
      {error && <p className="af-error af-social__error">{error}</p>}
      {dividerLabel && (
        <div className="af-divider" role="separator">
          <span>{dividerLabel}</span>
        </div>
      )}
    </div>
  );
}
