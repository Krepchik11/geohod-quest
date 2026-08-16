// @vitest-environment jsdom
/**
 * The downscale encode is JPEG, and JPEG has no alpha: a transparent source
 * must be flattened onto white before drawing, or its pixels serialize as
 * black. cropToQuestImage always did this; downscale must do the same.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

import { fileToOriginImage } from '../image-file';

type Op = { op: 'fill'; style: string } | { op: 'draw' };
const ops: Op[] = [];

const ctx = {
  fillStyle: '',
  fillRect: () => ops.push({ op: 'fill', style: String(ctx.fillStyle) }),
  drawImage: () => ops.push({ op: 'draw' }),
};

class FakeImage {
  naturalWidth = 2000;
  naturalHeight = 1000;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  set src(_v: string) {
    queueMicrotask(() => this.onload?.());
  }
}

beforeEach(() => {
  ops.length = 0;
  vi.stubGlobal('Image', FakeImage);
  HTMLCanvasElement.prototype.getContext = (() => ctx) as never;
  HTMLCanvasElement.prototype.toBlob = function (cb: BlobCallback) {
    cb(new Blob(['jpeg'], { type: 'image/jpeg' }));
  };
});

describe('fileToOriginImage downscale', () => {
  it('flattens onto white before drawing (transparent PNG must not go black)', async () => {
    // 2000px wide > MAX_DIMENSION forces the downscale/re-encode path.
    const file = new File(['png-bytes'], 'a.png', { type: 'image/png' });
    await fileToOriginImage(file);
    expect(ops[0]).toEqual({ op: 'fill', style: '#fff' });
    expect(ops[1]).toEqual({ op: 'draw' });
  });
});
