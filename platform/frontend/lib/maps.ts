/**
 * The single builder for external system-maps links (SPEC: «передача в
 * системные карты» — no in-bundle routing). Used by the player's clickable
 * address line and the product page's «Место старта» button, so the URL shape
 * can never drift between them.
 */
export function mapsSearchUrl(lat: number, lng: number): string {
  return `https://www.google.com/maps/search/?api=1&query=${lat},${lng}`;
}
