/**
 * Where the sign-in page sends the player back to (ТЗ, задача 5): a purchase
 * that asked them to sign in must come back to the quest it was buying, with the
 * purchase sheet open again — not to the main page.
 *
 * `next` is taken from the address bar, so only a path on this site is honored:
 * `//evil.example` and `/\evil.example` are protocol-relative to a browser and
 * would make the sign-in page an open redirect.
 */

/** The query flag that reopens the purchase sheet on a quest page. */
export const BUY_PARAM = 'buy';

/** A safe in-site path from a raw `next` value; `/` for anything else. */
export function safeNext(raw: string | null | undefined): string {
  if (!raw || !raw.startsWith('/') || raw.startsWith('//') || raw.startsWith('/\\')) return '/';
  return raw;
}

/** `/auth` that returns to `next` after a successful sign-in. */
export function authHref(next: string): string {
  return `/auth?next=${encodeURIComponent(safeNext(next))}`;
}

/** The quest page with its purchase sheet reopened. */
export function buyAgainPath(questId: string): string {
  return `/quest/${encodeURIComponent(questId)}/about?${BUY_PARAM}=1`;
}
