/**
 * The one phone breakpoint. Mirrors `@media (max-width: 767px)` in
 * app/globals.css — the width at which the site drops its nav into the tab bar,
 * the card grid becomes one column and a modal becomes a bottom sheet. Any JS
 * that has to know «is this a phone» reads it from here, so the two layers
 * cannot disagree.
 */
export const PHONE_MAX_PX = 767;
export const PHONE_QUERY = `(max-width: ${PHONE_MAX_PX}px)`;
