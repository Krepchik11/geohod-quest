/**
 * Pure geometry for the 4:3 step-image pipeline. Every step page carries one
 * image with a fixed contract: 4:3 aspect and ≤100 KB after compression. The
 * browser-only encode/compress half lives in image-file.ts; this module stays
 * node-testable.
 */

export const STEP_IMAGE_ASPECT = 4 / 3;
export const STEP_IMAGE_MAX_BYTES = 100 * 1024;
/** Relative aspect tolerance — absorbs off-by-one pixel after resizes. */
const ASPECT_TOLERANCE = 0.01;

export interface CropRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function matchesAspect(width: number, height: number): boolean {
  if (width <= 0 || height <= 0) return false;
  return Math.abs(width / height / STEP_IMAGE_ASPECT - 1) <= ASPECT_TOLERANCE;
}

/** Largest centered 4:3 rect that fits the source — the crop editor's start state. */
export function largestAspectRect(width: number, height: number): CropRect {
  const wide = width / height >= STEP_IMAGE_ASPECT;
  const w = wide ? Math.round(height * STEP_IMAGE_ASPECT) : width;
  const h = wide ? height : Math.round(width / STEP_IMAGE_ASPECT);
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
