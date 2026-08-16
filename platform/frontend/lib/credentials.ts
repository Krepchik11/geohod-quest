/**
 * The ONE client-side mirror of the backend's auth-boundary rules
 * (backend/src/auth.rs). goldens/wire/credentials.json pins both sides:
 * what passes here passes the server, so «Сервер недоступен» can no longer
 * mask a typo in the email (issue #66).
 *
 * Whitespace is Unicode White_Space, like Rust's char::is_whitespace — JS \s
 * misses U+0085 (NEL), so it is added explicitly. Lengths count Unicode code
 * points ([...s].length), matching the server's chars().count().
 */

const WS = /[\s\u0085]/;
const WS_EDGE = /^[\s\u0085]+|[\s\u0085]+$/g;

/** Canonical email form — trim + lowercase, exactly like the server. */
export function normalizeEmail(email: string): string {
  return email.replace(WS_EDGE, '').toLowerCase();
}

/** Server rule: at least 3 code points, has «@», no whitespace anywhere. */
export function emailValid(email: string): boolean {
  return [...email].length >= 3 && email.includes('@') && !WS.test(email);
}

/** Server rule: minimum 8 code points. */
export function passwordValid(password: string): boolean {
  return [...password].length >= 8;
}

export const EMAIL_ERROR = 'Проверьте адрес почты — в нём опечатка или пробел.';
export const PASSWORD_ERROR = 'Минимум 8 символов';

/** The message for an invalid email: a typo hint when it at least has an «@». */
export function emailError(normalized: string): string {
  return normalized.includes('@') ? EMAIL_ERROR : 'Укажите почту — например, anna@gmail.com';
}
