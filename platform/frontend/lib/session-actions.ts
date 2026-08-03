/**
 * Account session actions that span more than the identity store alone — kept out
 * of lib/identity so that module stays a thin, SSR-safe, dependency-free source of
 * "who is playing".
 */
import { api } from './api';
import { currentUserId, logout as clearSessionAndRotate } from './identity';
import { clearLocalPlay } from './queue';
import { flushAll } from './sync';

/**
 * Full logout for UI call sites.
 *
 * Order matters:
 *  1. Flush every still-pending fact to the server WHILE the session's bearer
 *     token is still valid — a registered account's unsynced facts would be
 *     rejected (401) once the session is gone, and then lost by the wipe below.
 *     Best-effort and fast: with nothing pending it makes no network calls, and
 *     offline it fast-fails; either way logout proceeds.
 *  2. Clear the session and rotate the device id (un-bricks anonymous use — see
 *     lib/identity.clearSession).
 *  3. Wipe this device's offline play state so the now-anonymous device is a clean
 *     visitor: no lingering attempts/facts to mis-attribute to the rotated id, no
 *     downloaded bundles to replay paid quests grant-free.
 *
 * Everything that synced stays on the account and returns on the next login.
 */
export async function logoutAndReset(): Promise<void> {
  try {
    await flushAll({ userId: currentUserId(), api });
  } catch {
    // Offline / unrecoverable — already-synced history stays on the account.
  }
  clearSessionAndRotate();
  try {
    await clearLocalPlay();
  } catch {
    // Storage unavailable — nothing to wipe.
  }
}
