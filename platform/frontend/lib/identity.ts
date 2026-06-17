/**
 * Identity module — the single source for "who is playing" (player-identity spec).
 *
 * Anonymous-first: the device mints one UUID (versioned localStorage key, locked
 * owner decision) and plays as `dev:<uuid>` with NO server round-trip — identity
 * exists before any network. Registration/login store a session here; while a
 * session exists the account's player_id is the current identity, and clearing
 * it reverts to the device's anonymous id.
 *
 * Server trust model: a Bearer token authenticates registered accounts; the
 * X-Player-Id header carries the anonymous claim (device possession is the
 * anonymous credential). `authHeaders()` picks the right one — every API call
 * goes through it (see lib/api.ts).
 */

const DEVICE_KEY = 'geohod-device-id:v1';
const SESSION_KEY = 'geohod-session:v1';

/** Stored session: opaque server token + the account identity it resolves to. */
export interface Session {
  token: string;
  player_id: string;
  email: string;
  display_name?: string | null;
}

/** True when persistent storage exists (browser); false on the server. */
function hasStorage(): boolean {
  return typeof localStorage !== 'undefined';
}

/** Mint-once device UUID. SSR/storage-failure fallback is a stable marker that
 * never persists (real id mints on first browser use). */
export function getDeviceId(): string {
  if (!hasStorage()) return 'ssr';
  try {
    let id = localStorage.getItem(DEVICE_KEY);
    if (!id) {
      id = crypto.randomUUID();
      localStorage.setItem(DEVICE_KEY, id);
    }
    return id;
  } catch {
    return 'local-device';
  }
}

/** The device-bound anonymous player id. */
export function anonymousPlayerId(): string {
  return `dev:${getDeviceId()}`;
}

let sessionCacheRaw: string | null = null;
let sessionCache: Session | null = null;

/**
 * Single shared session store. localStorage's `storage` event only fires in
 * OTHER tabs, so same-tab mutations (setSession/clearSession) notify explicitly.
 * Header, auth page and profile all subscribe here, so login/logout updates every
 * island live instead of leaving a stale menu behind.
 */
const sessionListeners = new Set<() => void>();
function notifySession(): void {
  for (const cb of sessionListeners) cb();
}

/** Subscribe to session changes (same-tab via notify, cross-tab via `storage`).
 * Shape matches React's `useSyncExternalStore` subscribe contract. */
export function subscribeSession(cb: () => void): () => void {
  sessionListeners.add(cb);
  if (typeof window !== 'undefined') window.addEventListener('storage', cb);
  return () => {
    sessionListeners.delete(cb);
    if (typeof window !== 'undefined') window.removeEventListener('storage', cb);
  };
}

/** Current session, or null when logged out (corrupt storage counts as logged
 * out). The returned object is referentially stable per stored value, so it is
 * safe as a `useSyncExternalStore` snapshot. */
export function getSession(): Session | null {
  if (!hasStorage()) return null;
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (raw === sessionCacheRaw) return sessionCache;
    sessionCacheRaw = raw;
    if (!raw) {
      sessionCache = null;
      return null;
    }
    const parsed = JSON.parse(raw) as Session;
    sessionCache = parsed.token && parsed.player_id ? parsed : null;
    return sessionCache;
  } catch {
    return null;
  }
}

/** Store the session after register/login. */
export function setSession(session: Session): void {
  try {
    localStorage.setItem(SESSION_KEY, JSON.stringify(session));
  } catch {
    // Storage unavailable: the user stays effectively anonymous this session.
  }
  notifySession();
}

/**
 * Logout: drop the session AND rotate the device id to a fresh, unregistered one.
 *
 * Why rotate (the bug this fixes): registration attaches the account to the
 * device's anonymous id — `dev:<uuid>` becomes a registered account (see
 * app/auth/page.tsx, which registers with `anonymousPlayerId()`). If logout merely
 * reverted to that same id, every tokenless `X-Player-Id` call would be rejected
 * by the backend ("registered account requires login", resolve_player), so the
 * device would be permanently bricked for anonymous use and the 401 would surface
 * as a misleading "сервер недоступен". Minting a new device id returns the device
 * to a clean anonymous visitor; account purchases/coins stay on the account and
 * return on the next login. Rotation is UNCONDITIONAL on purpose: the device id
 * can already be a registered account even when logging out of a *different*
 * account, so a conditional rotate would leave that case bricked.
 */
export function clearSession(): void {
  if (hasStorage()) {
    try {
      localStorage.removeItem(SESSION_KEY);
      localStorage.setItem(DEVICE_KEY, crypto.randomUUID());
    } catch {
      // Storage unavailable: nothing to clear or rotate.
    }
  }
  notifySession();
}

/** Logout helper for UI call sites (header, auth page): clears the session,
 * rotates the device id, and notifies subscribers. */
export function logout(): void {
  clearSession();
}

/** The acting player id: account when logged in, anonymous device id otherwise. */
export function currentPlayerId(): string {
  return getSession()?.player_id ?? anonymousPlayerId();
}

/** Identity headers for API calls: Bearer wins, X-Player-Id carries the anonymous claim. */
export function authHeaders(): Record<string, string> {
  const session = getSession();
  if (session) return { Authorization: `Bearer ${session.token}` };
  return { 'X-Player-Id': anonymousPlayerId() };
}
