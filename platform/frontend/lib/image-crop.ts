/**
 * Pure geometry for the 4:3 quest-image pipeline. Every image an author uploads
 * — page image, hint image, quest cover — is stored as a 4:3 crop of an
 * uncropped source, so the constructor can show it exactly as the player and the
 * store will. Only the byte budget differs per role. The browser-only
 * encode/compress half lives in image-file.ts; this module stays node-testable.
 */

export const QUEST_IMAGE_ASPECT = 4 / 3;
/** Page/hint images ride in the offline bundle — the tightest budget. */
export const STEP_IMAGE_MAX_BYTES = 100 * 1024;
/** The cover is rendered full-bleed (store hero, first screen) — more headroom. */
export const COVER_IMAGE_MAX_BYTES = 250 * 1024;
/** Relative aspect tolerance — absorbs off-by-one pixel after resizes. */
const ASPECT_TOLERANCE = 0.01;

/** «100 КБ» — one wording for the hint, the aside and the compression error. */
export function byteBudgetLabel(maxBytes: number): string {
  return `${Math.round(maxBytes / 1024)} КБ`;
}

export interface CropRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function matchesAspect(width: number, height: number): boolean {
  if (width <= 0 || height <= 0) return false;
  return Math.abs(width / height / QUEST_IMAGE_ASPECT - 1) <= ASPECT_TOLERANCE;
}

/** Largest centered 4:3 rect that fits the source — the crop editor's start state. */
export function largestAspectRect(width: number, height: number): CropRect {
  const wide = width / height >= QUEST_IMAGE_ASPECT;
  const w = wide ? Math.round(height * QUEST_IMAGE_ASPECT) : width;
  const h = wide ? height : Math.round(width / QUEST_IMAGE_ASPECT);
  return {
    x: Math.round((width - w) / 2),
    y: Math.round((height - h) / 2),
    width: w,
    height: h,
  };
}

/** Keep a dragged crop rect inside the source bounds without resizing it. */
export function clampCropRect(rect: CropRect, width: number, height: number): CropRect {
  return {
    ...rect,
    x: Math.min(Math.max(rect.x, 0), width - rect.width),
    y: Math.min(Math.max(rect.y, 0), height - rect.height),
  };
}

/**
 * Rect the crop editor opens on: the author's saved rect when it can still
 * belong to this source, otherwise the largest centered 4:3 one. A stored rect
 * is untrusted input (hand-edited body, source replaced under it), so a rect
 * that does not fit is discarded rather than clamped into a different crop.
 */
export function startCropRect(
  width: number,
  height: number,
  saved: CropRect | null | undefined,
): CropRect {
  const fits =
    saved
    && saved.width > 0
    && saved.height > 0
    && saved.width <= width
    && saved.height <= height
    && matchesAspect(saved.width, saved.height);
  return fits ? clampCropRect(saved, width, height) : largestAspectRect(width, height);
}
