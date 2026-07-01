/**
 * Single source of truth for resolving a quest's `primary_comic` cover field to a
 * usable URL. Post-R2-migration this is a fully-qualified `https://…/api/media/{hash}`
 * URL; legacy/dev data may carry a `/`-rooted path, a `data:` URI, or a non-URL token
 * (e.g. "comic-fortress") that is NOT a renderable image.
 *
 * Before this module, two call sites disagreed: the landing accepted `http`/`data:`/`/`,
 * while My Quests gated on `startsWith('/')` alone — so it blanked every production
 * https cover. Both now route through here.
 */

/** Drawn when a quest has no usable cover (id-style token, missing, etc.). */
export const CARD_PLACEHOLDER = '/assets/img/quest-card.png';

/** The cover URL when `primaryComic` is a real image ref, else null (caller draws its own placeholder). */
export function coverSrc(primaryComic?: string | null): string | null {
  const v = primaryComic?.trim();
  if (!v) return null;
  return v.startsWith('/') || v.startsWith('data:') || v.startsWith('http') ? v : null;
}

/** A `url('…')` value for CSS `background-image`, falling back to the card placeholder. */
export function coverCss(primaryComic?: string | null): string {
  return `url('${coverSrc(primaryComic) ?? CARD_PLACEHOLDER}')`;
}
