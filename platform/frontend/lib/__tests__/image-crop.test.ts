/**
 * Pure 4:3 crop geometry for the step-image pipeline: aspect check, largest
 * centered 4:3 rect, and drag clamping. The canvas encode/compress side lives
 * in image-file.ts (browser-only); everything testable in node lives here.
 */
import { describe, expect, it } from 'vitest';
import {
  COVER_IMAGE_MAX_BYTES,
  QUEST_IMAGE_ASPECT,
  STEP_IMAGE_MAX_BYTES,
  clampCropRect,
  largestAspectRect,
  matchesAspect,
  startCropRect,
} from '../image-crop';

describe('constants', () => {
  it('locks the contract: one 4:3 aspect for every quest image, 100 KB per page image', () => {
    expect(QUEST_IMAGE_ASPECT).toBeCloseTo(4 / 3);
    expect(STEP_IMAGE_MAX_BYTES).toBe(100 * 1024);
  });

  it('gives the cover its own (larger) byte budget — it is rendered full-bleed', () => {
    expect(COVER_IMAGE_MAX_BYTES).toBeGreaterThan(STEP_IMAGE_MAX_BYTES);
  });
});

describe('matchesAspect', () => {
  it('accepts exact 4:3', () => {
    expect(matchesAspect(800, 600)).toBe(true);
    expect(matchesAspect(4000, 3000)).toBe(true);
  });

  it('accepts tiny deviation (rounding after resize)', () => {
    // 801×600 is within 1% of 4:3
    expect(matchesAspect(801, 600)).toBe(true);
  });

  it('rejects 16:9, portrait and square', () => {
    expect(matchesAspect(1920, 1080)).toBe(false);
    expect(matchesAspect(600, 800)).toBe(false);
    expect(matchesAspect(700, 700)).toBe(false);
  });

  it('rejects degenerate sizes', () => {
    expect(matchesAspect(0, 600)).toBe(false);
    expect(matchesAspect(800, 0)).toBe(false);
  });
});

describe('largestAspectRect', () => {
  it('wide image: full height, horizontally centered', () => {
    expect(largestAspectRect(1000, 600)).toEqual({ x: 100, y: 0, width: 800, height: 600 });
  });

  it('tall image: full width, vertically centered', () => {
    expect(largestAspectRect(600, 1000)).toEqual({ x: 0, y: 275, width: 600, height: 450 });
  });

  it('already 4:3: identity rect', () => {
    expect(largestAspectRect(800, 600)).toEqual({ x: 0, y: 0, width: 800, height: 600 });
  });

  it('rect always fits inside the source', () => {
    for (const [w, h] of [[1920, 1080], [1080, 1920], [123, 457], [30, 4000]]) {
      const r = largestAspectRect(w, h);
      expect(r.x).toBeGreaterThanOrEqual(0);
      expect(r.y).toBeGreaterThanOrEqual(0);
      expect(r.x + r.width).toBeLessThanOrEqual(w);
      expect(r.y + r.height).toBeLessThanOrEqual(h);
      expect(r.width / r.height).toBeCloseTo(4 / 3, 1);
    }
  });
});

describe('startCropRect', () => {
  it('no saved rect: the largest centered 4:3 rect', () => {
    expect(startCropRect(1000, 600, null)).toEqual(largestAspectRect(1000, 600));
  });

  it('reopens on the saved rect — the author sees the crop they chose', () => {
    const saved = { x: 200, y: 0, width: 800, height: 600 };
    expect(startCropRect(1000, 600, saved)).toEqual(saved);
  });

  it('clamps a saved rect that hangs outside the source', () => {
    expect(startCropRect(1000, 600, { x: 900, y: 0, width: 800, height: 600 }))
      .toEqual({ x: 200, y: 0, width: 800, height: 600 });
  });

  it('discards a saved rect that cannot belong to this source', () => {
    // Bigger than the source, wrong aspect, or degenerate — fall back, never crash.
    expect(startCropRect(1000, 600, { x: 0, y: 0, width: 4000, height: 3000 }))
      .toEqual(largestAspectRect(1000, 600));
    expect(startCropRect(1000, 600, { x: 0, y: 0, width: 1000, height: 600 }))
      .toEqual(largestAspectRect(1000, 600));
    expect(startCropRect(1000, 600, { x: 0, y: 0, width: 0, height: 0 }))
      .toEqual(largestAspectRect(1000, 600));
  });
});

describe('clampCropRect', () => {
  it('keeps an in-bounds rect untouched', () => {
    const r = { x: 50, y: 0, width: 800, height: 600 };
    expect(clampCropRect(r, 1000, 600)).toEqual(r);
  });

  it('clamps a drag past the left/top edge to 0', () => {
    expect(clampCropRect({ x: -40, y: -5, width: 800, height: 600 }, 1000, 600))
      .toEqual({ x: 0, y: 0, width: 800, height: 600 });
  });

  it('clamps a drag past the right/bottom edge', () => {
    expect(clampCropRect({ x: 999, y: 0, width: 800, height: 600 }, 1000, 600))
      .toEqual({ x: 200, y: 0, width: 800, height: 600 });
    expect(clampCropRect({ x: 0, y: 700, width: 600, height: 450 }, 600, 1000))
      .toEqual({ x: 0, y: 550, width: 600, height: 450 });
  });
});
