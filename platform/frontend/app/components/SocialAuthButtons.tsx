'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { api, type AuthProviders, type TelegramWidgetUser } from '../../lib/api';
import { anonymousPlayerId, type Session } from '../../lib/identity';

/**
 * Google + Telegram sign-in buttons (social-auth spec). ONE component for both
 * jobs — signing in on /auth (anonymous caller) and linking a provider from the
 * profile (logged-in caller): the API layer attaches the identity headers either
 * way, so the backend decides create-vs-link. Each button renders only when its
 * provider is configured (GET /api/auth/providers), mirroring the fail-closed
 * backend, so an unconfigured deployment shows nothing rather than a dead button.
 *
 * Both providers load their own first-party script (no bundler import): Google
 * Identity Services renders the official button and hands us an ID token; the
 * Telegram Login Widget renders its button in an iframe and calls a global with
 * the signed user object. We forward each to the backend, which VERIFIES it
 * before trusting anything, then store the returned session.
 */

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
declare global {
  interface Window {
    google?: GoogleIdApi;
    onTelegramAuth?: (user: TelegramWidgetUser) => void;
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
  botUsername,
  onAuth,
}: {
  botUsername: string;
  onAuth: (user: TelegramWidgetUser) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  // Latest callback in a ref (assigned in an effect, not during render).
  const cb = useRef(onAuth);
  useEffect(() => {
    cb.current = onAuth;
  });

  useEffect(() => {
    window.onTelegramAuth = (user) => cb.current(user);
    const script = document.createElement('script');
    script.src = 'https://telegram.org/js/telegram-widget.js?22';
    script.async = true;
    script.setAttribute('data-telegram-login', botUsername);
    script.setAttribute('data-size', 'large');
    script.setAttribute('data-radius', '20');
    script.setAttribute('data-onauth', 'onTelegramAuth(user)');
    script.setAttribute('data-request-access', 'write');
    const slot = ref.current;
    slot?.appendChild(script);
    return () => {
      slot?.replaceChildren();
      delete window.onTelegramAuth;
    };
  }, [botUsername]);

  return <div className="social-btn social-btn--telegram" ref={ref} />;
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
        if (!cancelled) setProviders({ google_client_id: null, telegram_bot: null });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const fail = useCallback(
    (message: string) => {
      setBusy(false);
      setError(message);
      onError?.(message);
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
    (user: TelegramWidgetUser) => {
      setBusy(true);
      setError(null);
      api
        .authTelegram({ ...user, player_id: anonymousPlayerId() })
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
  const showTelegram = !!providers?.telegram_bot && !skip.has('telegram');
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
          <TelegramButton botUsername={providers!.telegram_bot!} onAuth={handleTelegram} />
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
