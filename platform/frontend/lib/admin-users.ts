/**
 * Pure core of the admin Users screen (admin-users spec): role tokens, search-term
 * detection, present-only contact extraction, role+search filtering, and RU
 * formatting. Kept out of the component so every rule is unit-testable and has a
 * single responsibility.
 *
 * Adapted from the design prototype to the real account model: the backend stores
 * email + display_name + role + created_at only — no telegram/phone/last-active — so
 * those fields are simply never produced (the UI renders present-only). The design's
 * `safeEmail` zero-width-space hack is a design-sandbox artifact (it defeated an
 * email obfuscator) and is deliberately NOT ported — it would corrupt copy/paste.
 */
import type { AdminUserWire } from './api';
import type { Role } from './roles';

// Re-exported so existing importers (`import { type Role } from './admin-users'`)
// keep working while the canonical definition lives in ./roles (admin-roles, DRY).
export type { Role };

/** Roles in display order (admin → editor → player), mirroring the backend. */
export const ROLE_ORDER: Role[] = ['admin', 'editor', 'player'];

/** Russian role labels for chips, badges and the role editor. */
export const ROLE_LABELS: Record<Role, string> = {
  admin: 'админ',
  editor: 'редактор',
  player: 'игрок',
};

/** Coerce an arbitrary wire role string to a known Role (unknown → player). */
export function asRole(role: string | null | undefined): Role {
  return (ROLE_ORDER as string[]).includes(role ?? '') ? (role as Role) : 'player';
}

/** View-model for one user (list row + detail). */
export interface AdminUser {
  id: string;
  email: string;
  displayName: string | null;
  role: Role;
  createdAt: number;
}

/** Map a wire account to the view-model. */
export function toAdminUser(w: AdminUserWire): AdminUser {
  return {
    id: w.player_id,
    email: w.email,
    displayName: w.display_name,
    role: asRole(w.role),
    createdAt: w.created_at,
  };
}

/**
 * Recognized search-term type for the «РАСПОЗНАНО» chip — a pure UI affordance
 * mirroring the design. The backend only stores email + display_name, so a
 * phone/telegram term recognizes a type but won't match real rows; that's expected.
 * Returns null when nothing is recognized.
 */
export function detectHint(raw: string): string | null {
  const s = (raw || '').trim();
  if (!s) return null;
  if (/^\+?[\d][\d\s().-]{3,}$/.test(s)) return 'телефон';
  if (s.includes('@')) return /@[^@\s]+\.[^@\s]+/.test(s) ? 'почта' : 'telegram';
  if (/^[a-zA-Z0-9_.]{2,}$/.test(s) && /[a-zA-Z_]/.test(s)) return 'telegram / логин';
  return null;
}

/**
 * Display title: name → email → defensive fallback. Every registered account has a
 * (unique, non-empty) email, so the fallback only guards malformed data.
 */
export function titleOf(u: AdminUser): string {
  return u.displayName?.trim() || u.email || 'Без имени';
}

/** A present-only contact row. */
export interface Contact {
  glyph: string;
  value: string;
}

/**
 * Contact rows that actually exist for this user. The backend models only email,
 * so that's the sole row; telegram/phone are kept out rather than rendered empty
 * (present-only, per the design's explicit decision).
 */
export function contactsOf(u: AdminUser): Contact[] {
  const out: Contact[] = [];
  if (u.email) out.push({ glyph: '✉', value: u.email });
  return out;
}

/**
 * Case-insensitive substring match over name + email (a leading `@` is ignored so
 * a telegram-style query still matches a handle stored as the display name).
 */
export function matchesUser(u: AdminUser, query: string): boolean {
  const q = query.trim();
  if (!q) return true;
  const needle = q.toLowerCase().replace(/^@/, '');
  return [u.displayName, u.email].some((v) => !!v && v.toLowerCase().includes(needle));
}

/**
 * Role filter (multiselect, OR within the chosen roles) AND the search term.
 * Order-preserving — the server already sorts newest-first.
 */
export function filterUsers(users: AdminUser[], activeRoles: Role[], query: string): AdminUser[] {
  return users
    .filter((u) => activeRoles.length === 0 || activeRoles.includes(u.role))
    .filter((u) => matchesUser(u, query));
}

/** «N пользовател-ь / -я / -ей» with correct Russian plural agreement. */
export function pluralizeUsers(n: number): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  const word =
    mod10 === 1 && mod100 !== 11
      ? 'пользователь'
      : mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)
        ? 'пользователя'
        : 'пользователей';
  return `${n} ${word}`;
}

/**
 * Format unix seconds as DD.MM.YY (the design's join-date format). Uses UTC so the
 * output is deterministic and test-stable regardless of the runtime timezone.
 * Non-positive / missing timestamps render as an em dash.
 */
export function formatJoined(unixSeconds: number): string {
  if (!unixSeconds || unixSeconds <= 0) return '—';
  const d = new Date(unixSeconds * 1000);
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const yy = String(d.getUTCFullYear() % 100).padStart(2, '0');
  return `${dd}.${mm}.${yy}`;
}
