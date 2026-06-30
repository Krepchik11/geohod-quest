/** Author identity mapping: bubble user -> our users row fields. Shared by load + report. */
import { createHash } from 'node:crypto';
import { USER_ID_PREFIX } from './config.ts';
import type { BubbleUser } from './types.ts';

export const short = (id: string) => createHash('sha1').update(id).digest('hex').slice(0, 6);
export const userId = (bubbleId: string) => USER_ID_PREFIX + bubbleId;
export const realEmail = (u: BubbleUser): string | undefined => u.authentication?.email?.email?.trim() || undefined;

/**
 * Account email is ALWAYS synthesized (.invalid) so a login-disabled import account
 * never occupies a real person's address (users.email is UNIQUE → would block their
 * future signup). The real email, when known, is kept for reference (raw/ + report).
 */
export function authorEmail(u: BubbleUser): { email: string; real: string | undefined } {
  return { email: `bubble-${short(u._id)}@imported.geohod.invalid`, real: realEmail(u) };
}

export function authorName(u: BubbleUser): string {
  return u.username?.trim() || realEmail(u)?.split('@')[0] || `Автор ${short(u._id)}`;
}
