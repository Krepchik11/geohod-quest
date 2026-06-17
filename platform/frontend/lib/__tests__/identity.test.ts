import { beforeEach, describe, expect, it } from 'vitest';

// Minimal localStorage shim (node env — no jsdom needed; the module guards on
// localStorage availability, which is exactly what SSR sees too).
class StorageShim {
  private map = new Map<string, string>();
  getItem(k: string) { return this.map.has(k) ? this.map.get(k)! : null; }
  setItem(k: string, v: string) { this.map.set(k, String(v)); }
  removeItem(k: string) { this.map.delete(k); }
  clear() { this.map.clear(); }
}
(globalThis as Record<string, unknown>).localStorage = new StorageShim();

import {
  anonymousPlayerId,
  authHeaders,
  clearSession,
  currentPlayerId,
  getDeviceId,
  getSession,
  setSession,
  type Session,
} from '../identity';

const SESSION: Session = {
  token: 'a'.repeat(64),
  player_id: 'dev:11111111-1111-4111-8111-111111111111',
  email: 'p@example.com',
  display_name: null,
};

beforeEach(() => {
  localStorage.clear();
});

describe('device identity', () => {
  it('mints one UUID, persists it under the versioned key, and reuses it', () => {
    const first = getDeviceId();
    expect(first).toMatch(/^[0-9a-f-]{36}$/);
    expect(localStorage.getItem('geohod-device-id:v1')).toBe(first);
    expect(getDeviceId()).toBe(first);
  });

  it('derives the anonymous player id as dev:<uuid>', () => {
    expect(anonymousPlayerId()).toBe(`dev:${getDeviceId()}`);
  });
});

describe('session', () => {
  it('roundtrips set/get/clear under the versioned key', () => {
    expect(getSession()).toBeNull();
    setSession(SESSION);
    expect(getSession()).toEqual(SESSION);
    expect(localStorage.getItem('geohod-session:v1')).toBeTruthy();
    clearSession();
    expect(getSession()).toBeNull();
  });

  it('treats corrupt stored JSON as logged out', () => {
    localStorage.setItem('geohod-session:v1', '{not json');
    expect(getSession()).toBeNull();
  });
});

describe('currentPlayerId', () => {
  it('is the anonymous device id while logged out', () => {
    expect(currentPlayerId()).toBe(anonymousPlayerId());
  });

  it('is the account id while a session exists, and reverts on logout', () => {
    setSession(SESSION);
    expect(currentPlayerId()).toBe(SESSION.player_id);
    clearSession();
    expect(currentPlayerId()).toBe(anonymousPlayerId());
  });
});

describe('logout rotates the device id (un-bricks anonymous use)', () => {
  // Registration binds the account to the device's dev:<uuid>; if logout kept that
  // id, the backend would 401 every anonymous call ("registered account requires
  // login"). clearSession must mint a FRESH device id so the post-logout anonymous
  // identity is not the now-registered one.
  it('mints a fresh device id on clearSession', () => {
    const before = getDeviceId();
    setSession(SESSION);
    clearSession();
    const after = getDeviceId();
    expect(after).not.toBe(before);
    expect(after).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('sends the fresh anonymous id (not the registered one) after logout', () => {
    setSession(SESSION);
    clearSession();
    const headers = authHeaders();
    expect(headers).toEqual({ 'X-Player-Id': anonymousPlayerId() });
    // The post-logout claimed id must differ from the registered account id.
    expect(headers['X-Player-Id']).not.toBe(SESSION.player_id);
  });
});

describe('authHeaders', () => {
  it('sends X-Player-Id while anonymous (device possession is the credential)', () => {
    expect(authHeaders()).toEqual({ 'X-Player-Id': anonymousPlayerId() });
  });

  it('sends the Bearer token while a session exists', () => {
    setSession(SESSION);
    expect(authHeaders()).toEqual({ Authorization: `Bearer ${SESSION.token}` });
  });
});
