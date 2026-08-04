'use client';

import React, { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import SocialAuthButtons from '../components/SocialAuthButtons';
import { api, classify } from '../../lib/api';
import {
  anonymousUserId,
  clearSession,
  getSession,
  setSession,
  subscribeSession,
  type Session,
} from '../../lib/identity';

/**
 * Auth v2 (§6.1/§6.2) — ONE email-first form instead of the two-pill toggle.
 * The server decides the mode: POST /api/auth/identify says whether the email
 * has an account, then the card shows either «С возвращением!» (login) or
 * «Создадим аккаунт» (register). The 409 «already registered» class disappears
 * by construction (a defensive message remains).
 *
 * Recovery is R1 (mailed link, §6.2): request → «Письмо ушло» with a resend
 * cooldown; the link lands on /auth/reset. Registration still attaches the
 * anonymous player id, so coins and purchases survive — and the form says so.
 */
type Step =
  | { name: 'email' }
  | { name: 'login'; email: string; confirmed: boolean }
  | { name: 'register'; email: string }
  | { name: 'recover'; email: string; confirmed: boolean }
  | { name: 'recover-sent'; email: string; masked: string; confirmed: boolean };

/** Show/hide toggle for a password field (§6: «Показать» on every field). */
export function PasswordField({
  label,
  value,
  hint,
  error,
  autoComplete,
  onChange,
  onEnter,
}: {
  label: string;
  value: string;
  hint?: string;
  error?: React.ReactNode;
  autoComplete: string;
  onChange: (v: string) => void;
  onEnter?: () => void;
}) {
  const [shown, setShown] = useState(false);
  return (
    <label className="af-field">
      <span className="af-field__label">{label}</span>
      <span className={`af-field__wrap ${error ? 'is-error' : ''}`}>
        <input
          className="af-field__input"
          type={shown ? 'text' : 'password'}
          value={value}
          aria-label={label}
          autoComplete={autoComplete}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') onEnter?.(); }}
        />
        <button className="af-field__show" type="button" onClick={() => setShown((v) => !v)}>
          {shown ? 'Скрыть' : 'Показать'}
        </button>
      </span>
      {hint && !error && <span className="af-field__hint">{hint}</span>}
      {error && <span className="af-field__error">{error}</span>}
    </label>
  );
}

function EmailChip({ email, onEdit }: { email: string; onEdit: () => void }) {
  return (
    <span className="af-chip">
      {email}
      <button type="button" onClick={onEdit}>изменить</button>
    </span>
  );
}

/** Resend cooldown for the «Письмо ушло» state (mm:ss). */
function useCooldown(seconds: number): [number, () => void] {
  const [left, setLeft] = useState(seconds);
  useEffect(() => {
    if (left <= 0) return;
    const t = setTimeout(() => setLeft((v) => v - 1), 1000);
    return () => clearTimeout(t);
  }, [left]);
  return [left, () => setLeft(seconds)];
}

const RESEND_COOLDOWN_SECS = 60;

export default function AuthPage() {
  const [step, setStep] = useState<Step>({ name: 'email' });
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [consent, setConsent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldError, setFieldError] = useState<React.ReactNode>(null);
  const [loading, setLoading] = useState(false);
  const session: Session | null = useSyncExternalStore(subscribeSession, getSession, () => null);
  const router = useRouter();

  // Signed in — whether just now or on arrival — means this page has nothing
  // left to do: go straight to the main page (no interim «Вы вошли» card).
  useEffect(() => {
    if (session) router.replace('/');
  }, [session, router]);

  const applySession = useCallback((s: Session | null) => {
    if (s) setSession(s);
    else clearSession();
  }, []);

  const toEmailStep = () => {
    setStep({ name: 'email' });
    setPassword('');
    setError(null);
    setFieldError(null);
  };

  const identify = async () => {
    const v = email.trim().toLowerCase();
    if (v.length < 3 || !v.includes('@')) {
      setError('Укажите почту — например, anna@gmail.com');
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const res = await api.authIdentify(v);
      setStep(res.exists ? { name: 'login', email: v, confirmed: res.confirmed } : { name: 'register', email: v });
    } catch (e) {
      setError(classify(e).kind === 'rate-limited' ? 'Слишком много попыток — подождите минуту.' : 'Сервер недоступен — попробуйте позже.');
    } finally {
      setLoading(false);
    }
  };

  const login = async (s: Extract<Step, { name: 'login' }>) => {
    setLoading(true);
    setFieldError(null);
    try {
      applySession(await api.authLogin({ email: s.email, password }));
    } catch (e) {
      if (classify(e).kind === 'unauthorized') {
        setFieldError(
          <>Неверный пароль.{' '}
            <button className="af-inline-link" type="button" onClick={() => setStep({ name: 'recover', email: s.email, confirmed: s.confirmed })}>
              Восстановить?
            </button>
          </>,
        );
      } else {
        setError('Сервер недоступен — попробуйте позже.');
      }
    } finally {
      setLoading(false);
    }
  };

  const registerAccount = async (s: Extract<Step, { name: 'register' }>) => {
    if (!consent) {
      setError('Отметьте согласие с условиями — без него аккаунт создать нельзя.');
      return;
    }
    if (password.length < 8) {
      setFieldError('Минимум 8 символов');
      return;
    }
    setLoading(true);
    setError(null);
    setFieldError(null);
    try {
      applySession(await api.authRegister({ user_id: anonymousUserId(), email: s.email, password }));
    } catch (e) {
      const f = classify(e);
      // §6.1.6: this class should be unreachable now — defensive message only.
      if (f.kind === 'rejected' && f.status === 409) setError('Эта почта уже занята — вернитесь назад и войдите.');
      else setError('Сервер недоступен — попробуйте позже.');
    } finally {
      setLoading(false);
    }
  };

  const recover = async (s: Extract<Step, { name: 'recover' }>) => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.authRecover(s.email);
      setStep({ name: 'recover-sent', email: s.email, masked: res.masked, confirmed: s.confirmed });
    } catch (e) {
      setError(classify(e).kind === 'rate-limited' ? 'Слишком много писем — подождите и попробуйте позже.' : 'Сервер недоступен — попробуйте позже.');
    } finally {
      setLoading(false);
    }
  };

  if (session) return null; // redirecting (effect above)

  return (
    <div className="af-card card">
      {/* §6.1.5: ✕ always navigates home — never history.back(). */}
      <Link className="af-close" href="/" aria-label="Закрыть">✕</Link>

      {step.name === 'email' && (
        <>
          <h2 className="af-title">Вход или регистрация</h2>
          <p className="af-sub">Аккаунт сохранит покупки, монеты и прогресс при смене устройства.</p>
          {/* Fast path first: one tap with Google or Telegram. Each button
              appears only when the server has that provider configured; the
              "или по почте" divider follows only when a button is shown. */}
          <SocialAuthButtons onSession={applySession} onError={setError} dividerLabel="или по почте" />
          <label className="af-field">
            <span className="af-field__label">Email</span>
            <span className="af-field__wrap">
              <input
                className="af-field__input"
                type="email"
                value={email}
                autoComplete="email"
                aria-label="Email"
                onChange={(e) => setEmail(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') void identify(); }}
              />
            </span>
          </label>
          {error && <p className="af-error">{error}</p>}
          <button className="btn btn--block" type="button" disabled={loading} onClick={() => void identify()}>
            {loading ? 'Проверяем…' : 'Продолжить'}
          </button>
          <p className="af-caption">Играть можно и без аккаунта — вернитесь к этому позже.</p>
        </>
      )}

      {step.name === 'login' && (
        <>
          <h2 className="af-title">С возвращением!</h2>
          <EmailChip email={step.email} onEdit={toEmailStep} />
          <PasswordField
            label="Пароль"
            value={password}
            error={fieldError}
            autoComplete="current-password"
            onChange={setPassword}
            onEnter={() => void login(step)}
          />
          <button
            className="af-forgot"
            type="button"
            onClick={() => setStep({ name: 'recover', email: step.email, confirmed: step.confirmed })}
          >
            Забыли пароль?
          </button>
          {error && <p className="af-error">{error}</p>}
          <button className="btn btn--block" type="button" disabled={loading} onClick={() => void login(step)}>
            {loading ? 'Входим…' : 'Войти'}
          </button>
        </>
      )}

      {step.name === 'register' && (
        <>
          <h2 className="af-title">Создадим аккаунт</h2>
          <EmailChip email={step.email} onEdit={toEmailStep} />
          <PasswordField
            label="Придумайте пароль"
            value={password}
            hint="Минимум 8 символов"
            error={fieldError}
            autoComplete="new-password"
            onChange={setPassword}
            onEnter={() => void registerAccount(step)}
          />
          <label className="af-consent">
            <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
            <span>
              Принимаю <Link href="/terms">пользовательское соглашение</Link> и{' '}
              <Link href="/privacy">политику конфиденциальности</Link>
            </span>
          </label>
          {error && <p className="af-error">{error}</p>}
          <button className="btn btn--block" type="button" disabled={loading} onClick={() => void registerAccount(step)}>
            {loading ? 'Создаём…' : 'Зарегистрироваться'}
          </button>
          <div className="af-note-good">✓ Монеты и покупки этого устройства привяжутся к аккаунту.</div>
        </>
      )}

      {step.name === 'recover' && (
        <>
          <h2 className="af-title">Восстановление пароля</h2>
          <p className="af-sub">
            {step.confirmed
              ? 'Пришлём ссылку для смены пароля.'
              : 'Почта ещё не подтверждена — сначала отправим письмо-подтверждение, затем восстановление станет доступно.'}
          </p>
          <span className="af-chip">{step.email}</span>
          {error && <p className="af-error">{error}</p>}
          <button className="btn btn--block" type="button" disabled={loading} onClick={() => void recover(step)}>
            {loading ? 'Отправляем…' : step.confirmed ? 'Отправить ссылку' : 'Отправить подтверждение'}
          </button>
          <button className="af-back" type="button" onClick={() => setStep({ name: 'login', email: step.email, confirmed: step.confirmed })}>
            ← Назад ко входу
          </button>
        </>
      )}

      {step.name === 'recover-sent' && (
        <RecoverSent
          masked={step.masked}
          confirmed={step.confirmed}
          onResend={() => api.authRecover(step.email)}
          onCode={async (code, newPassword) => {
            applySession(await api.authResetPassword({ email: step.email, code, password: newPassword }));
          }}
          onBack={toEmailStep}
        />
      )}
    </div>
  );
}

/**
 * «Письмо ушло» card. For a confirmed account the reset mail carries a link
 * AND a 6-digit code (§6.2 R2) — the code is typed right here, so a mobile
 * user reads it off the mail notification and never leaves the app (a link
 * would open in the browser, stranding the PWA session). An unconfirmed
 * account got a confirmation mail instead — no code to type.
 */
function RecoverSent({
  masked,
  confirmed,
  onResend,
  onCode,
  onBack,
}: {
  masked: string;
  confirmed: boolean;
  onResend: () => Promise<unknown>;
  onCode: (code: string, newPassword: string) => Promise<void>;
  onBack: () => void;
}) {
  const [left, restart] = useCooldown(RESEND_COOLDOWN_SECS);
  const [error, setError] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const mm = Math.floor(left / 60);
  const ss = String(left % 60).padStart(2, '0');
  const resend = () => {
    setError(null);
    restart();
    onResend().catch((e) => {
      setError(classify(e).kind === 'rate-limited' ? 'Слишком много писем — подождите и попробуйте позже.' : 'Не получилось отправить — попробуйте позже.');
    });
  };
  const submitCode = async () => {
    if (!/^\d{6}$/.test(code)) {
      setError('Код из письма — 6 цифр.');
      return;
    }
    if (newPassword.length < 8) {
      setError('Минимум 8 символов');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await onCode(code, newPassword);
    } catch (e) {
      const f = classify(e);
      setError(f.kind === 'rejected' && f.status === 400
        ? 'Код не подошёл или устарел — проверьте цифры или запросите новое письмо.'
        : 'Сервер недоступен — попробуйте позже.');
    } finally {
      setSubmitting(false);
    }
  };
  return (
    <div className="af-sent">
      <span className="af-sent__icon" aria-hidden>✉</span>
      <b>Письмо ушло</b>
      {confirmed ? (
        <>
          <p>Отправили код и ссылку на {masked} — действуют 30 минут. Не пришло — проверьте «Спам».</p>
          <label className="af-field">
            <span className="af-field__label">Код из письма</span>
            <span className="af-field__wrap">
              <input
                className="af-field__input"
                type="text"
                inputMode="numeric"
                autoComplete="one-time-code"
                value={code}
                aria-label="Код из письма"
                onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
              />
            </span>
          </label>
          <PasswordField
            label="Новый пароль"
            value={newPassword}
            hint="Минимум 8 символов"
            autoComplete="new-password"
            onChange={setNewPassword}
            onEnter={() => void submitCode()}
          />
          {error && <p className="af-error">{error}</p>}
          <button className="btn btn--block" type="button" disabled={submitting} onClick={() => void submitCode()}>
            {submitting ? 'Проверяем…' : 'Сменить пароль и войти'}
          </button>
        </>
      ) : (
        <>
          <p>Отправили письмо для подтверждения почты на {masked}. Подтвердите её по ссылке и запросите восстановление ещё раз.</p>
          {error && <p className="af-error">{error}</p>}
        </>
      )}
      {left > 0 ? (
        <button className="btn btn--quiet btn--sm" type="button" disabled>
          Отправить ещё раз · {mm}:{ss}
        </button>
      ) : (
        <button className="btn btn--quiet btn--sm" type="button" onClick={resend}>
          Отправить ещё раз
        </button>
      )}
      <button className="af-back" type="button" onClick={onBack}>← Назад ко входу</button>
    </div>
  );
}
