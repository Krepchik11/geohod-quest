/**
 * Central API client (YAGNI simple, robust per constraints).
 * Uses NEXT_PUBLIC_API_URL (recommended when using custom ports) || http://localhost:8080 fallback.
 * 
 * For your custom ports setup:
 *   PORT=8087 npm run dev:backend
 *   NEXT_PUBLIC_API_URL=http://localhost:8087 PORT=8089 npm run dev:frontend
 *
 * The NEXT_PUBLIC_ prefix makes the value available in the browser bundle.
 *
 * All calls go through here. Idempotent where backend supports.
 */

import { authHeaders, type Session } from './identity';

const API_BASE = (typeof process !== 'undefined' && process.env.NEXT_PUBLIC_API_URL) || 'http://localhost:8080';

/** Published quest meta as served by GET /api/quests (mirrors backend PublishedMeta). */
export interface PublishedQuestWire {
  quest_id: string;
  name: string;
  primary_comic: string | null;
  template_summary: string;
  snapshot_version: number;
  snapshot_id: string;
}

/** AccessGrant as served by GET /api/grants. */
export interface GrantWire {
  player_id: string;
  quest_id: string;
  granted_at: string;
  source: string;
  source_ref: string | null;
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
    throw new Error(`API ${res.status} ${path}: ${text || res.statusText}`);
  }
  if (res.status === 204) return {} as T;
  return res.json() as Promise<T>;
}

export const api = {
  checkout: (body: { player_id: string; quest_id: string; coupon_percent?: number }) =>
    apiFetch('/api/checkout', { method: 'POST', body: JSON.stringify(body) }),

  publishQuest: (body: Record<string, unknown>) =>
    apiFetch('/api/quests/publish', { method: 'POST', body: JSON.stringify(body) }),

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

  // Admin / visibility (pure from facts); pass the expected shape at the call site
  getVersionStats: <T = unknown>(versionId: string) => apiFetch<T>(`/api/admin/versions/${versionId}/stats`),
  getVersionFeedbacks: <T = unknown>(versionId: string) => apiFetch<T>(`/api/admin/versions/${versionId}/feedbacks`),

  // Published + grants (for cabinet/market live)
  listQuests: () => apiFetch<PublishedQuestWire[]>('/api/quests'),
  listGrants: () => apiFetch<GrantWire[]>('/api/grants'),

  // Identity (player-identity spec): registration attaches email+password to the
  // caller's EXISTING anonymous player id (id never changes); login returns the
  // account identity for this device to adopt. Both return a session.
  authRegister: (body: { player_id: string; email: string; password: string; display_name?: string }) =>
    apiFetch<Session>('/api/auth/register', { method: 'POST', body: JSON.stringify(body) }),
  authLogin: (body: { email: string; password: string }) =>
    apiFetch<Session>('/api/auth/login', { method: 'POST', body: JSON.stringify(body) }),
  me: () =>
    apiFetch<{ player_id: string; registered: boolean; email: string | null; display_name: string | null }>(
      '/api/players/me'
    ),
  myStats: () =>
    apiFetch<{
      balance: number;
      quests_completed: number;
      completed_quest_ids: string[];
      attempts_count: number;
      grants_count: number;
    }>('/api/players/me/stats'),
};

export type ApiError = Error;
