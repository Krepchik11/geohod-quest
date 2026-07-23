/**
 * Central API client. Every backend request goes through `apiFetch`, which attaches
 * the identity headers (Bearer for a registered session, X-Player-Id for an anonymous
 * device — see lib/identity) and normalizes non-2xx responses into `ApiError`
 * carrying the HTTP status.
 *
 * The base URL is NEXT_PUBLIC_API_URL, inlined into the browser bundle at build time
 * (see `resolveApiBase` for the production-safety guard against the localhost fallback).
 */

import type { AdminFeatureWire } from './admin-features';
import { authHeaders, type Session } from './identity';

/** Which social sign-in providers this deployment has configured. Both `null`
 *  when unset, so the client hides the corresponding button (fail-closed UI that
 *  mirrors the fail-closed 501 backend). Both are PUBLIC client ids: `google_client_id`
 *  for Google Identity Services; `telegram_client_id` (the bot's Client ID) for
 *  `Telegram.Login.init`. */
export interface AuthProviders {
  google_client_id: string | null;
  telegram_client_id: string | null;
}

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

/** Raw counters for one admin-stats period (`GET /api/admin/stats*`). */
export interface AdminStatsTotalsWire {
  purchased: number;
  started: number;
  finished: number;
}

export interface AdminStatsDailyWire {
  date: string;
  started: number;
  finished: number;
}

export interface AdminStatsQuestRowWire {
  quest_id: string;
  name: string;
  city: string | null;
  template_summary: string;
  pages: number | null;
  /** false = delisted quest kept for reconciliation; no detail page exists. */
  published: boolean;
  purchased: number;
  started: number;
  finished: number;
}

export interface AdminStatsOverviewWire {
  from: string;
  to: string;
  totals: AdminStatsTotalsWire;
  /** Same-length previous window; null for «Всё время». */
  prev: AdminStatsTotalsWire | null;
  daily: AdminStatsDailyWire[];
  quests: AdminStatsQuestRowWire[];
}

export interface AdminStatsFunnelStepWire {
  position: number;
  title: string;
  template: string;
  reached: number;
}

export interface AdminStatsQuestWire {
  quest_id: string;
  name: string;
  city: string | null;
  template_summary: string;
  /** Step-count chip frozen at publish; same field as the overview rows. */
  pages: number | null;
  from: string;
  to: string;
  totals: AdminStatsTotalsWire;
  prev: AdminStatsTotalsWire | null;
  snapshot_id: string;
  snapshot_version: number;
  /** Funnel denominator: attempts of the current snapshot started in range. */
  funnel_started: number;
  funnel: AdminStatsFunnelStepWire[];
}

/** One coupon as served by the admin coupon endpoints (coupons spec): the
 *  stored record plus the DERIVED status and the usage fold. `quest_ids: null`
 *  means «все квесты»; null limits mean unlimited. */
export interface AdminCouponWire {
  coupon_id: string;
  code: string;
  discount_type: 'percent' | 'fixed';
  discount_value: number;
  valid_until: string | null;
  max_redemptions: number | null;
  per_user_limit: number | null;
  quest_ids: string[] | null;
  paused: boolean;
  status: 'active' | 'paused' | 'expired' | 'exhausted';
  used: number;
  last_redeemed_at: string | null;
  total_discounted: number;
  created_at: string;
}

/** Editable coupon fields as the admin form submits them (create + save). */
export interface CouponPayload {
  code: string;
  discount_type: 'percent' | 'fixed';
  discount_value: number;
  valid_until: string | null;
  max_redemptions: number | null;
  per_user_limit: number | null;
  quest_ids: string[] | null;
  paused: boolean;
}

/** Verdict of POST /api/coupons/validate — always 200, never consumes. */
export type CouponVerdict =
  | { valid: true; code: string; price: number; discount_amount: number; final_price: number }
  | { valid: false; message: string };

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
  /** Public players counter = real distinct completions + the author's marketing
   *  bonus (set in the constructor). Server-computed; the raw bonus never ships. */
  players: number;
  /** Author attributes from the constructor row (store filters); null/empty for
   *  a legacy/direct publish that has no constructor row. */
  complexity: string | null;
  age_target: string | null;
  tags: string[];
}

/** Product page payload (§3.1) — the published card + live rating + author
 *  attribution + snapshot-derived content chips + the store description. */
export interface ProductPageWire extends PublishedQuestWire {
  description: string | null;
  /** Author display label; null for legacy/direct publishes. */
  author_name: string | null;
  /** How many of this author's quests are currently on sale. */
  author_published_count: number;
  /** Content chips; null when the version predates chip derivation. */
  pages: number | null;
  tasks: number | null;
  paid_hints: boolean | null;
  /** §11 reviews v1: newest-first, first 10; total with text for the header. */
  reviews: ReviewWire[];
  reviews_total: number;
  /** «Место старта» — the quest's first map point; null hides the button. */
  start_point: StartPointWire | null;
}

/** The quest start point (first navigator point of the published snapshot). */
export interface StartPointWire {
  lat: number;
  lng: number;
  label: string | null;
}

/** §11: one public review (author first name only, month-precision date). */
export interface ReviewWire {
  author: string;
  rating: number;
  text: string;
  created_at: number;
}

/** The grant-gated bundle envelope returned by `GET /api/quests/{id}/bundle` — the
 *  frozen snapshot JSON plus its identity. The download flow stores/precaches from it. */
export interface BundleWire {
  quest_id: string;
  snapshot_id: string;
  snapshot_version: number;
  /** Catalog cover (`primary_comic`) — lives in the bundle envelope, not the frozen
   *  snapshot, so the client can precache it for offline alongside the snapshot media. */
  primary_comic: string | null;
  snapshot: unknown;
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
  /** Distinct grant holders — the honest «{N} купивших» for destructive confirms (§9.1). */
  buyers: number;
  /** Live published snapshot version; null ⇒ test/published need the publish panel first. */
  published_version: number | null;
  /** Сложность (закрытый набор low/medium/high) — фильтруемая колонка дашборда. */
  complexity: string;
  /** Аудитория (закрытый набор kids/everyone/18plus). */
  age_target: string;
  /** Собственные теги автора (свободные строки). */
  tags: string[];
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
  complexity: string;
  age_target: string;
  tags: string[];
  body: unknown;
}

/** Reference returned by POST /api/media (mirrors backend MediaRef). The quest body
 *  stores `url`; the bytes live content-addressed in R2 under `hash`. */
export interface MediaRefWire {
  url: string;
  hash: string;
  content_type: string;
  size: number;
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

/** The backend's `{"error": msg}` body when present, else the fallback — for
 *  surfacing the server's human (Russian) message instead of a generic one. */
export function apiErrorMessage(err: unknown, fallback: string): string {
  if (err instanceof ApiError) {
    try {
      const parsed = JSON.parse(err.body) as { error?: string };
      if (parsed.error) return parsed.error;
    } catch {
      /* non-JSON body — fall through */
    }
  }
  return fallback;
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

/**
 * POST /api/checkout is grant-or-redirect: the mock provider (and free /
 * coupon-100% orders) settles instantly with `{grant, created}`; a redirect
 * provider (ЮKassa) answers `{payment}` — send the payer to `confirmation_url`,
 * then poll `paymentStatus(payment_id)` on return.
 */
export type CheckoutResult =
  | { grant: GrantWire; created: boolean; payment?: never }
  | { payment: { payment_id: string; confirmation_url: string }; grant?: never };

/** Verdict of GET /api/payments/{id} — the owner poll after a redirect. */
export interface PaymentStatusWire {
  status: 'pending' | 'succeeded' | 'canceled';
  grant: GrantWire | null;
}

let providersPromise: Promise<{ providers: string[] }> | null = null;

export const api = {
  checkout: (body: {
    player_id: string;
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
  validateCoupon: (body: { player_id: string; quest_id: string; code: string }) =>
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
  createAttempt: (body: { player_id: string; quest_id: string }) =>
    apiFetch<{ attempt_id: string; snapshot_id: string }>('/api/attempts', {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  getAttemptState: (attemptId: string) => apiFetch(`/api/attempts/${attemptId}/state`),

  // Bundle download primitive: latest frozen snapshot JSON, grant-gated (403 without grant).
  getBundle: (questId: string, playerId: string): Promise<BundleWire> =>
    apiFetch<BundleWire>(`/api/quests/${questId}/bundle?player_id=${encodeURIComponent(playerId)}`),

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
  // caller's EXISTING anonymous player id (id never changes); login returns the
  // account identity for this device to adopt. Both return a session.
  authRegister: (body: { player_id: string; email: string; password: string; display_name?: string }) =>
    apiFetch<Session>('/api/auth/register', { method: 'POST', body: JSON.stringify(body) }),
  authLogin: (body: { email: string; password: string }) =>
    apiFetch<Session>('/api/auth/login', { method: 'POST', body: JSON.stringify(body) }),
  // Social sign-in (social-auth spec). Both attach to the caller's anonymous
  // player_id (coins/purchases survive) or link to a logged-in account; the
  // backend verifies the provider payload before any account effect. Both return
  // a Session exactly like register/login.
  authGoogle: (body: { credential: string; player_id: string }) =>
    apiFetch<Session>('/api/auth/google', { method: 'POST', body: JSON.stringify(body) }),
  authTelegram: (body: { id_token: string; player_id: string }) =>
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
  // Public effective verdicts of the client-visible feature flags (the player
  // runtime keys UI behavior off these; see lib/client-features.ts).
  getPublicFeatures: () =>
    apiFetch<Record<string, boolean>>('/api/features'),
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
    apiFetch<{ status: string; email: string }>('/api/auth/confirm', {
      method: 'POST',
      body: JSON.stringify({ token }),
    }),
  authResendConfirm: () =>
    apiFetch<{ status: string }>('/api/auth/confirm/resend', { method: 'POST', body: '{}' }),
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
  me: () =>
    apiFetch<{
      player_id: string;
      registered: boolean;
      email: string | null;
      display_name: string | null;
      role: string | null;
      /** §6.3: unix seconds when the email was confirmed; null/absent until then. */
      email_confirmed_at?: number | null;
      /** Active sign-in methods: "email" (when set) + each linked provider
       *  ("google"/"telegram"). Drives the profile "Способы входа" block. */
      methods?: string[];
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
