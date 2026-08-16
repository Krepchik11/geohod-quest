/**
 * Central API client. Every backend request goes through `apiFetch`, which attaches
 * the identity headers (Bearer for a registered session, X-User-Id for an anonymous
 * device — see lib/identity) and normalizes non-2xx responses into `ApiError`
 * carrying the HTTP status.
 *
 * The base URL is NEXT_PUBLIC_API_URL, inlined into the browser bundle at build time
 * (see `resolveApiBase` for the production-safety guard against the localhost fallback).
 */

import { authHeaders, type Session } from './identity';
import type {
  AdminCouponWire,
  AdminFeatureWire,
  AdminFeedbackResponse,
  AdminReviewsResponse,
  AdminSettingWire,
  AdminStatsOverviewWire,
  AdminStatsQuestWire,
  AdminUserWire,
  AttemptMeta,
  AuthProviders,
  BundleWire,
  CheckoutResult,
  ConstructorAuthorWire,
  ConstructorQuestFullWire,
  ConstructorQuestWire,
  CouponPayload,
  CouponVerdict,
  FeedbackResolveBody,
  GrantWire,
  Me,
  MediaRefWire,
  PaymentStatusWire,
  PlayerStats,
  ProductPageWire,
  PublicFeatures,
  PublishedQuestWire,
  ReviewHideBody,
  ReviewsPageWire,
} from './generated';

/**
 * Wire types are GENERATED from the backend's serde structs (ts-rs; see
 * backend `cargo test export_bindings` and lib/generated/). Nothing here is
 * hand-maintained — a renamed server field changes lib/generated/ in the same
 * commit, and CI fails if the two sides drift (issue #66).
 */
export type * from './generated';

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

export const API_BASE = resolveApiBase();

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

/** Query string for the admin stats endpoints (inclusive UTC day range). */
function statsRangeQuery(range: { from?: string; to?: string }): string {
  const params = new URLSearchParams();
  if (range.from) params.set('from', range.from);
  if (range.to) params.set('to', range.to);
  const qs = params.toString();
  return qs ? `?${qs}` : '';
}

/** Editorial lifecycle of a constructor quest (mirrors backend CTOR_STATUS_*). */
export type CtorStatus = ConstructorQuestWire['status'];

/** Create/save payload: the denormalized list fields + the full opaque body. */
export interface ConstructorQuestUpsert {
  name: string;
  cover: string | null;
  steps_count: number;
  complexity: string;
  age_target: string;
  tags: string[];
  body: unknown;
}

/**
 * Error thrown for every non-2xx API response. Screens never read `status` or
 * the message text directly — they branch on `classify(err)`; the message is
 * for logs only.
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

/** The backend's `{"error": msg}` reason out of an error body, `null` otherwise. */
function serverReason(body: string): string | null {
  try {
    const parsed = JSON.parse(body) as { error?: string };
    return parsed.error || null;
  } catch {
    return null;
  }
}

/** The backend's `{"error": msg}` body when present, else the fallback — for
 *  surfacing the server's human (Russian) message instead of a generic one. */
export function apiErrorMessage(err: unknown, fallback: string): string {
  return (err instanceof ApiError && serverReason(err.body)) || fallback;
}

/**
 * The ONE decoder of API failures (issue #67). Every screen branches on this
 * closed union instead of re-reading statuses or parsing error text; the seven
 * verdicts cover every situation a screen must present differently.
 * `rejected` (endpoint-local 4xx like «почта занята») carries the status and
 * the server's human reason for the screen to branch further.
 */
export type ApiFailure =
  | { kind: 'unauthorized' }
  | { kind: 'forbidden' }
  | { kind: 'not-found' }
  | { kind: 'rate-limited' }
  | { kind: 'rejected'; status: number; error: string | null }
  | { kind: 'server-broken' }
  | { kind: 'offline' };

export function classify(err: unknown): ApiFailure {
  // Not an API response at all — fetch failed before the server answered
  // (network down) or something else threw; either way there is no verdict
  // from the server to decode.
  if (!(err instanceof ApiError)) return { kind: 'offline' };
  if (err.status === 401) return { kind: 'unauthorized' };
  if (err.status === 403) return { kind: 'forbidden' };
  if (err.status === 404) return { kind: 'not-found' };
  if (err.status === 429) return { kind: 'rate-limited' };
  if (err.status >= 500) return { kind: 'server-broken' };
  return { kind: 'rejected', status: err.status, error: serverReason(err.body) };
}

/** «Не вошли или нет прав» — the shared login-gate branch of the screens. */
export function isAuthFailure(err: unknown): boolean {
  const kind = classify(err).kind;
  return kind === 'unauthorized' || kind === 'forbidden';
}

export async function apiFetch<T = unknown>(path: string, init?: RequestInit): Promise<T> {
  const url = path.startsWith('http') ? path : `${API_BASE}${path.startsWith('/') ? '' : '/'}${path}`;
  const res = await fetch(url, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      // Identity on every call: Bearer for registered sessions, X-User-Id for
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

let providersPromise: Promise<{ providers: string[] }> | null = null;

export const api = {
  checkout: (body: {
    user_id: string;
    quest_id: string;
    coupon_code?: string;
    provider?: string;
  }) => apiFetch<CheckoutResult>('/api/checkout', { method: 'POST', body: JSON.stringify(body) }),

  // Payment providers this deployment can charge through (drives the purchase
  // sheet's method selector; "mock" is always present). Deployment-static, so
  // one fetch per page load — repeat sheet opens resolve instantly.
  paymentProviders: () =>
    (providersPromise ??= apiFetch<{ providers: string[] }>('/api/payments/providers').catch(
      (e: unknown) => {
        providersPromise = null; // never cache a failure
        throw e;
      },
    )),

  // Owner poll for a redirect payment; the backend lazily settles a pending
  // payment against ЮKassa, so polling alone completes the purchase.
  paymentStatus: (paymentId: string) =>
    apiFetch<PaymentStatusWire>(`/api/payments/${encodeURIComponent(paymentId)}`),

  // Purchase-sheet promo preview: the discount lives in the server-side coupon
  // registry — this never consumes the code and always resolves to a verdict.
  validateCoupon: (body: { user_id: string; quest_id: string; code: string }) =>
    apiFetch<CouponVerdict>('/api/coupons/validate', {
      method: 'POST',
      body: JSON.stringify(body),
    }),

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
  createAttempt: (body: { user_id: string; quest_id: string }) =>
    apiFetch<AttemptMeta>('/api/attempts', {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  getAttemptState: (attemptId: string) => apiFetch(`/api/attempts/${attemptId}/state`),

  // Bundle download primitive: latest frozen snapshot JSON, grant-gated (403 without grant).
  getBundle: (questId: string, userId: string): Promise<BundleWire> =>
    apiFetch<BundleWire>(`/api/quests/${questId}/bundle?user_id=${encodeURIComponent(userId)}`),

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
  adminSetUserRole: (userId: string, role: string) =>
    apiFetch<AdminUserWire>(`/api/admin/users/${encodeURIComponent(userId)}/role`, {
      method: 'POST',
      headers: adminHeaders(),
      body: JSON.stringify({ role }),
    }),

  // Admin feature toggles (features spec) — same dual-credential gating as the
  // other admin endpoints. `enabled: null` clears the override (back to the
  // code default); the mutation returns the updated row.
  adminListFeatures: () =>
    apiFetch<AdminFeatureWire[]>('/api/admin/features', { headers: adminHeaders() }),
  adminSetFeature: (key: string, enabled: boolean | null) =>
    apiFetch<AdminFeatureWire>(`/api/admin/features/${encodeURIComponent(key)}`, {
      method: 'POST',
      headers: adminHeaders(),
      body: JSON.stringify({ enabled }),
    }),

  // Admin runtime settings (registry in backend settings.rs) — same gating.
  // `value: null` (or blank — the backend trims) clears the setting; the
  // mutation returns the normalized stored value.
  adminGetSetting: (key: string) =>
    apiFetch<AdminSettingWire>(`/api/admin/settings/${encodeURIComponent(key)}`, {
      headers: adminHeaders(),
    }),
  adminSetSetting: (key: string, value: string | null) =>
    apiFetch<AdminSettingWire>(`/api/admin/settings/${encodeURIComponent(key)}`, {
      method: 'POST',
      headers: adminHeaders(),
      body: JSON.stringify({ value }),
    }),

  // Admin statistics (admin-stats spec) — same dual-credential gating. Raw
  // counters over an inclusive UTC day range; omitting `from` = «Всё время»
  // (the backend anchors the range at the earliest recorded event).
  adminStatsOverview: (range: { from?: string; to?: string }) =>
    apiFetch<AdminStatsOverviewWire>(`/api/admin/stats${statsRangeQuery(range)}`, {
      headers: adminHeaders(),
    }),
  adminStatsQuest: (questId: string, range: { from?: string; to?: string }) =>
    apiFetch<AdminStatsQuestWire>(
      `/api/admin/stats/${encodeURIComponent(questId)}${statsRangeQuery(range)}`,
      { headers: adminHeaders() },
    ),

  // Content moderation (Отзывы + Обратная связь) — same dual-credential gating as
  // the other admin endpoints. The list GETs return every rating / feedback group
  // with resolved author identity; the mutations answer 204 (apiFetch → {}).
  adminListReviews: () =>
    apiFetch<AdminReviewsResponse>('/api/admin/reviews', { headers: adminHeaders() }),
  adminHideReview: (body: ReviewHideBody) =>
    apiFetch<void>('/api/admin/reviews/hide', {
      method: 'POST',
      headers: adminHeaders(),
      body: JSON.stringify(body),
    }),
  adminUnhideReview: (body: ReviewHideBody) =>
    apiFetch<void>('/api/admin/reviews/unhide', {
      method: 'POST',
      headers: adminHeaders(),
      body: JSON.stringify(body),
    }),
  adminListFeedback: () =>
    apiFetch<AdminFeedbackResponse>('/api/admin/feedback', { headers: adminHeaders() }),
  adminResolveFeedback: (body: FeedbackResolveBody) =>
    apiFetch<void>('/api/admin/feedback/resolve', {
      method: 'POST',
      headers: adminHeaders(),
      body: JSON.stringify(body),
    }),
  adminReopenFeedback: (body: FeedbackResolveBody) =>
    apiFetch<void>('/api/admin/feedback/reopen', {
      method: 'POST',
      headers: adminHeaders(),
      body: JSON.stringify(body),
    }),

  // Admin coupon management (coupons spec) — same dual-credential gating as the
  // user endpoints (role==admin session OR the shared ADMIN_TOKEN). Mutations are
  // POST-only, matching the backend's GET+POST router surface.
  adminListCoupons: () =>
    apiFetch<AdminCouponWire[]>('/api/admin/coupons', { headers: adminHeaders() }),
  adminGetCoupon: (couponId: string) =>
    apiFetch<AdminCouponWire>(`/api/admin/coupons/${encodeURIComponent(couponId)}`, {
      headers: adminHeaders(),
    }),
  adminCreateCoupon: (payload: CouponPayload) =>
    apiFetch<AdminCouponWire>('/api/admin/coupons', {
      method: 'POST',
      headers: adminHeaders(),
      body: JSON.stringify(payload),
    }),
  adminSaveCoupon: (couponId: string, payload: CouponPayload) =>
    apiFetch<AdminCouponWire>(`/api/admin/coupons/${encodeURIComponent(couponId)}/save`, {
      method: 'POST',
      headers: adminHeaders(),
      body: JSON.stringify(payload),
    }),
  adminDeleteCoupon: (couponId: string) =>
    apiFetch(`/api/admin/coupons/${encodeURIComponent(couponId)}/delete`, {
      method: 'POST',
      headers: adminHeaders(),
      body: JSON.stringify({}),
    }),

  // Published + grants (for cabinet/market live)
  listQuests: () => apiFetch<PublishedQuestWire[]>('/api/quests'),
  getQuestProduct: (id: string) =>
    apiFetch<ProductPageWire>(`/api/quests/${encodeURIComponent(id)}`),
  getQuestReviews: (id: string, offset: number) =>
    apiFetch<ReviewsPageWire>(`/api/quests/${encodeURIComponent(id)}/reviews?offset=${offset}`),
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
  // `cover` echoes back what the server actually stored: a `data:` blob in a
  // legacy body is externalized to a media URL, and the editor adopts it so the
  // next autosave no longer ships megabytes of base64.
  saveConstructorQuest: (id: string, body: ConstructorQuestUpsert) =>
    apiFetch<{ status: string; quest_id: string; updated_at: number; cover: string | null }>(
      `/api/constructor/quests/${encodeURIComponent(id)}/save`,
      { method: 'POST', headers: adminHeaders(), body: JSON.stringify(body) },
    ),
  setConstructorStatus: (id: string, status: CtorStatus) =>
    apiFetch<ConstructorQuestWire>(`/api/constructor/quests/${encodeURIComponent(id)}/status`, {
      method: 'POST',
      headers: adminHeaders(),
      body: JSON.stringify({ status }),
    }),
  // Who a quest may be handed to, and the handover itself. Both admin-only on
  // the server (see handlers/constructor.rs) — the constructor hides them from
  // everyone else, and the API refuses regardless.
  listConstructorAuthors: () =>
    apiFetch<ConstructorAuthorWire[]>('/api/constructor/authors', { headers: adminHeaders() }),
  setConstructorAuthor: (id: string, authorId: string) =>
    apiFetch<ConstructorQuestWire>(`/api/constructor/quests/${encodeURIComponent(id)}/author`, {
      method: 'POST',
      headers: adminHeaders(),
      body: JSON.stringify({ author_id: authorId }),
    }),
  deleteConstructorQuest: (id: string) =>
    apiFetch<{ status: string; quest_id: string }>(
      `/api/constructor/quests/${encodeURIComponent(id)}/delete`,
      { method: 'POST', headers: adminHeaders(), body: '{}' },
    ),

  // Full quest backup (record + all steps + media) as a zip. Binary
  // response — apiFetch is JSON-only, so this does its own fetch, like uploadMedia.
  exportConstructorQuest: async (id: string): Promise<Blob> => {
    const path = `/api/constructor/quests/${encodeURIComponent(id)}/export`;
    const res = await fetch(`${API_BASE}${path}`, {
      headers: { ...authHeaders(), ...adminHeaders() },
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new ApiError(res.status, path, text || res.statusText);
    }
    return res.blob();
  },

  // Upload a quest image (editor-gated). Sends RAW bytes (not JSON) — apiFetch is
  // JSON-only, so this does its own fetch — and the backend hashes them (sha256) and
  // stores them content-addressed in R2, returning the public URL the body
  // references. An editor's Bearer session (authHeaders) authorizes it; adminHeaders
  // forwards the ops token for an operator/dev build, like the other constructor calls.
  uploadMedia: async (blob: Blob): Promise<MediaRefWire> => {
    const res = await fetch(`${API_BASE}/api/media`, {
      method: 'POST',
      headers: { 'Content-Type': blob.type || 'image/jpeg', ...authHeaders(), ...adminHeaders() },
      body: blob,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new ApiError(res.status, '/api/media', text || res.statusText);
    }
    return res.json() as Promise<MediaRefWire>;
  },

  // Identity (player-identity spec): registration attaches email+password to the
  // caller's EXISTING anonymous user id (id never changes); login returns the
  // account identity for this device to adopt. Both return a session.
  authRegister: (body: { user_id: string; email: string; password: string; display_name?: string }) =>
    apiFetch<Session>('/api/auth/register', { method: 'POST', body: JSON.stringify(body) }),
  authLogin: (body: { email: string; password: string }) =>
    apiFetch<Session>('/api/auth/login', { method: 'POST', body: JSON.stringify(body) }),
  // Social sign-in (social-auth spec). Both attach to the caller's anonymous
  // user_id (coins/purchases survive) or link to a logged-in account; the
  // backend verifies the provider payload before any account effect. Both return
  // a Session exactly like register/login.
  authGoogle: (body: { credential: string; user_id: string }) =>
    apiFetch<Session>('/api/auth/google', { method: 'POST', body: JSON.stringify(body) }),
  authTelegram: (body: { id_token: string; user_id: string }) =>
    apiFetch<Session>('/api/auth/telegram', { method: 'POST', body: JSON.stringify(body) }),
  // Unlink a linked social provider (refused server-side if it is the last method).
  authUnlink: (provider: string) =>
    apiFetch<{ status: string }>('/api/auth/unlink', {
      method: 'POST',
      body: JSON.stringify({ provider }),
    }),
  // Which social buttons to render + the public ids they need. Both null → hidden.
  getAuthProviders: () =>
    apiFetch<AuthProviders>('/api/auth/providers'),
  // Public effective verdicts of the client-visible feature flags plus the
  // platform-wide universal answer (the player runtime keys behavior off
  // these; see lib/client-features.ts).
  getPublicFeatures: () =>
    apiFetch<PublicFeatures>('/api/features'),
  // Auth v2 (§6): the email-first step + recovery R1 + soft confirmation.
  authIdentify: (email: string) =>
    apiFetch<{ exists: boolean; confirmed: boolean }>('/api/auth/identify', {
      method: 'POST',
      body: JSON.stringify({ email }),
    }),
  authRecover: (email: string) =>
    apiFetch<{ status: string; masked: string }>('/api/auth/recover', {
      method: 'POST',
      body: JSON.stringify({ email }),
    }),
  // Reset finishes with either mailed credential: the link token (R1) or the
  // email-scoped 6-digit code (R2, typed in-app).
  authResetPassword: (
    body: { token: string; password: string } | { email: string; code: string; password: string },
  ) => apiFetch<Session>('/api/auth/reset', { method: 'POST', body: JSON.stringify(body) }),
  authConfirmEmail: (token: string) =>
    apiFetch<{ status: string; email: string; changed: boolean }>('/api/auth/confirm', {
      method: 'POST',
      body: JSON.stringify({ token }),
    }),
  authChangeEmail: (new_email: string, current_password: string | null) =>
    apiFetch<{ status: 'sent' }>('/api/auth/email', {
      method: 'POST',
      body: JSON.stringify({ new_email, current_password }),
    }),
  authResendConfirm: () =>
    apiFetch<{ status: 'sent' | 'already-confirmed' }>('/api/auth/confirm/resend', {
      method: 'POST',
      body: '{}',
    }),
  authChangePassword: (body: { current_password: string; new_password: string }) =>
    apiFetch<{ status: string }>('/api/auth/change-password', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  authSetDisplayName: (displayName: string | null) =>
    apiFetch<{ status: string; display_name: string | null }>('/api/auth/display-name', {
      method: 'POST',
      body: JSON.stringify({ display_name: displayName }),
    }),
  authDeleteAccount: () =>
    apiFetch<{ status: string }>('/api/auth/delete-account', { method: 'POST', body: '{}' }),
  me: () => apiFetch<Me>('/api/users/me'),
  myStats: () =>
    apiFetch<PlayerStats>('/api/users/me/stats'),
};
