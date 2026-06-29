/**
 * Central API client. Every backend request goes through `apiFetch`, which attaches
 * the identity headers (Bearer for a registered session, X-Player-Id for an anonymous
 * device — see lib/identity) and normalizes non-2xx responses into `ApiError`
 * carrying the HTTP status.
 *
 * The base URL is NEXT_PUBLIC_API_URL, inlined into the browser bundle at build time
 * (see `resolveApiBase` for the production-safety guard against the localhost fallback).
 */

import { authHeaders, type Session } from './identity';

/**
 * Resolved at BUILD time: NEXT_PUBLIC_* is string-inlined into the browser
 * bundle by `next build`, so this value is frozen at deploy time, not runtime.
 *
 * Production safety: a missing env var must FAIL THE BUILD, never silently ship
 * `http://localhost:8080` to end users (which would point every visitor's API
 * calls at their own machine). The localhost fallback is kept ONLY for local
 * dev and tests, where the build-time throw would be unhelpful.
 */
function resolveApiBase(): string {
  const explicit = typeof process !== 'undefined' ? process.env.NEXT_PUBLIC_API_URL : undefined;
  if (explicit) return explicit;
  if (typeof process !== 'undefined' && process.env.NODE_ENV === 'production') {
    throw new Error(
      'NEXT_PUBLIC_API_URL is not set. It must be configured for production builds ' +
        '(e.g. in Vercel project Environment Variables) so the API base is not the localhost fallback.',
    );
  }
  return 'http://localhost:8080';
}

const API_BASE = resolveApiBase();

/**
 * Header carrying the shared admin secret for the gated telemetry endpoints
 * (stats/feedbacks). Sourced from NEXT_PUBLIC_ADMIN_TOKEN — bundle-visible, so
 * only suitable for an internal admin tool; a public deployment should proxy
 * these server-side instead. Empty when unset (backend then returns 401/403).
 */
function adminHeaders(): Record<string, string> {
  const token = typeof process !== 'undefined' ? process.env.NEXT_PUBLIC_ADMIN_TOKEN : undefined;
  return token ? { 'X-Admin-Token': token } : {};
}

/**
 * True when a build-time admin secret is configured (NEXT_PUBLIC_ADMIN_TOKEN).
 * The admin page uses it to allow the operator/bootstrap path even before any
 * role==admin account exists; on a public deployment it is unset, so access falls
 * back to role-based session authorization alone. Bundle-visible by nature — only
 * set it for an internal admin build.
 */
export function hasAdminToken(): boolean {
  return Object.keys(adminHeaders()).length > 0;
}

/** One registered account as served by GET /api/admin/users (admin-users spec). */
export interface AdminUserWire {
  player_id: string;
  email: string;
  display_name: string | null;
  role: string;
  created_at: number;
}

/** Published quest meta as served by GET /api/quests (mirrors backend CatalogQuest:
 *  the stored PublishedMeta + the live aggregate rating). `city`/`duration`/`price`
 *  are the author's real store-card fields (null when left blank / unset); the store
 *  card shows exactly these, never fabricated values. `rating_count === 0` means
 *  "no ratings yet" — shown honestly rather than as a number. */
export interface PublishedQuestWire {
  quest_id: string;
  name: string;
  primary_comic: string | null;
  template_summary: string;
  snapshot_version: number;
  snapshot_id: string;
  city: string | null;
  duration: string | null;
  /** Whole rubles; 0 is an explicitly free quest, null is unset (legacy). */
  price: number | null;
  /** Mean finale rating (1–5) of the published version; 0.0 when unrated. */
  rating_avg: number;
  /** Number of attempts that left a finale rating. */
  rating_count: number;
}

/** Editorial lifecycle of a constructor quest (mirrors backend CTOR_STATUS_*). */
export type CtorStatus = 'draft' | 'test' | 'published';

/** One constructor dashboard row (mirrors backend ConstructorQuestWire). */
export interface ConstructorQuestWire {
  quest_id: string;
  name: string;
  /** Author display label (denormalized at creation). */
  author: string;
  author_id: string;
  status: CtorStatus;
  /** Page count. */
  steps: number;
  /** Distinct players who completed the quest ("прохождения"; derived from facts). */
  completed: number;
  // No `cover`: the dashboard renders a name-derived thumbnail, so the backend
  // omits the heavy base64 cover from list rows (it bloated the list to megabytes
  // for media-heavy quests). The cover is on the full wire below; the builder
  // reads it from `body.meta.cover` anyway.
  /** Unix seconds. */
  created_at: number;
  updated_at: number;
}

/** A constructor quest WITH its full editable body — returned by GET one (for the
 *  builder to open). `body` is the opaque CtorQuest JSON the server round-trips. */
export interface ConstructorQuestFullWire extends ConstructorQuestWire {
  body: unknown;
  /** Stored cover image (GET-one only; the list omits it). */
  cover: string | null;
}

/** Create/save payload: the denormalized list fields + the full opaque body. */
export interface ConstructorQuestUpsert {
  name: string;
  cover: string | null;
  steps_count: number;
  body: unknown;
}

/** AccessGrant as served by GET /api/grants. */
export interface GrantWire {
  player_id: string;
  quest_id: string;
  granted_at: string;
  source: string;
  source_ref: string | null;
}

/**
 * Error thrown for every non-2xx API response. Carries the numeric HTTP `status`
 * so callers can tell an auth failure (401/403) apart from a real outage instead
 * of mislabeling a 401 as "сервер недоступен". The message preserves the legacy
 * `API <status> <path>: <body>` format so existing substring/regex consumers
 * (e.g. BundleGate's httpStatus) keep working unchanged.
 */
export class ApiError extends Error {
  readonly status: number;
  readonly path: string;
  readonly body: string;
  constructor(status: number, path: string, body: string) {
    super(`API ${status} ${path}: ${body}`);
    this.name = 'ApiError';
    this.status = status;
    this.path = path;
    this.body = body;
  }
}

export async function apiFetch<T = unknown>(path: string, init?: RequestInit): Promise<T> {
  const url = path.startsWith('http') ? path : `${API_BASE}${path.startsWith('/') ? '' : '/'}${path}`;
  const res = await fetch(url, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      // Identity on every call: Bearer for registered sessions, X-Player-Id for
      // anonymous devices (player-identity spec).
      ...authHeaders(),
      ...(init?.headers || {}),
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new ApiError(res.status, path, text || res.statusText);
  }
  if (res.status === 204) return {} as T;
  return res.json() as Promise<T>;
}

export const api = {
  checkout: (body: { player_id: string; quest_id: string; coupon_percent?: number }) =>
    apiFetch('/api/checkout', { method: 'POST', body: JSON.stringify(body) }),

  // Publishing is the editor capability (backend require_editor): the editor's
  // Bearer session (always sent by authHeaders) authorizes it. adminHeaders() is
  // also forwarded so an operator build (NEXT_PUBLIC_ADMIN_TOKEN set) can publish
  // via the shared-secret path even before any editor/admin account exists — the
  // same dual-credential model the admin endpoints use. Unset in public builds, so
  // nothing extra is sent and access is purely role-based.
  publishQuest: (body: Record<string, unknown>) =>
    apiFetch('/api/quests/publish', {
      method: 'POST',
      headers: adminHeaders(),
      body: JSON.stringify(body),
    }),

  // Grant-gated attempt creation: 403 without a grant, 404 for unpublished quests.
  createAttempt: (body: { player_id: string; quest_id: string }) =>
    apiFetch<{ attempt_id: string; snapshot_id: string }>('/api/attempts', {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  getAttemptState: (attemptId: string) => apiFetch(`/api/attempts/${attemptId}/state`),

  // Bundle download primitive: latest frozen snapshot JSON, grant-gated (403 without grant).
  getBundle: (questId: string, playerId: string) =>
    apiFetch<{ quest_id: string; snapshot_id: string; snapshot_version: number; snapshot: unknown }>(
      `/api/quests/${questId}/bundle?player_id=${encodeURIComponent(playerId)}`
    ),

  appendFacts: (attemptId: string, facts: unknown[]) =>
    apiFetch(`/api/attempts/${attemptId}/facts`, { method: 'POST', body: JSON.stringify({ facts }) }),

  // Admin / visibility (pure from facts); pass the expected shape at the call site.
  // Gated by ADMIN_TOKEN on the backend; the internal admin UI forwards it via
  // adminHeaders() (NEXT_PUBLIC_ADMIN_TOKEN).
  getVersionStats: <T = unknown>(versionId: string) =>
    apiFetch<T>(`/api/admin/versions/${versionId}/stats`, { headers: adminHeaders() }),
  getVersionFeedbacks: <T = unknown>(versionId: string) =>
    apiFetch<T>(`/api/admin/versions/${versionId}/feedbacks`, { headers: adminHeaders() }),

  // Admin user management (admin-users spec). Gated server-side by a role==admin
  // session OR the shared ADMIN_TOKEN; adminHeaders() forwards the latter when the
  // build configures it (otherwise the Bearer session is the sole credential).
  adminListUsers: () =>
    apiFetch<AdminUserWire[]>('/api/admin/users', { headers: adminHeaders() }),
  adminSetUserRole: (playerId: string, role: string) =>
    apiFetch<AdminUserWire>(`/api/admin/users/${encodeURIComponent(playerId)}/role`, {
      method: 'POST',
      headers: adminHeaders(),
      body: JSON.stringify({ role }),
    }),

  // Published + grants (for cabinet/market live)
  listQuests: () => apiFetch<PublishedQuestWire[]>('/api/quests'),
  listGrants: () => apiFetch<GrantWire[]>('/api/grants'),

  // Constructor dashboard (editor-gated, like publish). adminHeaders() forwards the
  // ops token so an operator build (NEXT_PUBLIC_ADMIN_TOKEN) reaches the surface
  // before any editor account exists — and so dev (anonymous + ops token) works;
  // an editor's Bearer session (always sent via authHeaders) is the public path.
  listConstructorQuests: () =>
    apiFetch<ConstructorQuestWire[]>('/api/constructor/quests', { headers: adminHeaders() }),
  getConstructorQuest: (id: string) =>
    apiFetch<ConstructorQuestFullWire>(`/api/constructor/quests/${encodeURIComponent(id)}`, {
      headers: adminHeaders(),
    }),
  createConstructorQuest: (body: ConstructorQuestUpsert & { quest_id: string }) =>
    apiFetch<ConstructorQuestWire>('/api/constructor/quests', {
      method: 'POST',
      headers: adminHeaders(),
      body: JSON.stringify(body),
    }),
  saveConstructorQuest: (id: string, body: ConstructorQuestUpsert) =>
    apiFetch<{ status: string; quest_id: string; updated_at: number }>(
      `/api/constructor/quests/${encodeURIComponent(id)}/save`,
      { method: 'POST', headers: adminHeaders(), body: JSON.stringify(body) },
    ),
  setConstructorStatus: (id: string, status: CtorStatus) =>
    apiFetch<ConstructorQuestWire>(`/api/constructor/quests/${encodeURIComponent(id)}/status`, {
      method: 'POST',
      headers: adminHeaders(),
      body: JSON.stringify({ status }),
    }),
  deleteConstructorQuest: (id: string) =>
    apiFetch<{ status: string; quest_id: string }>(
      `/api/constructor/quests/${encodeURIComponent(id)}/delete`,
      { method: 'POST', headers: adminHeaders(), body: '{}' },
    ),

  // Identity (player-identity spec): registration attaches email+password to the
  // caller's EXISTING anonymous player id (id never changes); login returns the
  // account identity for this device to adopt. Both return a session.
  authRegister: (body: { player_id: string; email: string; password: string; display_name?: string }) =>
    apiFetch<Session>('/api/auth/register', { method: 'POST', body: JSON.stringify(body) }),
  authLogin: (body: { email: string; password: string }) =>
    apiFetch<Session>('/api/auth/login', { method: 'POST', body: JSON.stringify(body) }),
  me: () =>
    apiFetch<{
      player_id: string;
      registered: boolean;
      email: string | null;
      display_name: string | null;
      role: string | null;
    }>('/api/players/me'),
  myStats: () =>
    apiFetch<{
      balance: number;
      quests_completed: number;
      completed_quest_ids: string[];
      attempts_count: number;
      grants_count: number;
    }>('/api/players/me/stats'),
};
