// @vitest-environment jsdom
/** The downscale path must flatten alpha onto white BEFORE drawing (JPEG has none). */
import { describe, expect, it, vi } from 'vitest';

import { fileToOriginImage } from '../image-file';

const ops: string[] = [];

const ctx = {
  canvas: undefined as HTMLCanvasElement | undefined,
  fillStyle: '',
  fillRect: () => ops.push(`fill:${ctx.fillStyle}`),
  drawImage: () => ops.push('draw'),
};

class FakeImage {
  naturalWidth = 2000;
  naturalHeight = 1000;
  onload: (() => void) | null = null;
  set src(_v: string) {
    queueMicrotask(() => this.onload?.());
  }
}

vi.stubGlobal('Image', FakeImage);
HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement) {
  ctx.canvas = this;
  return ctx;
} as never;
HTMLCanvasElement.prototype.toBlob = function (cb: BlobCallback) {
  cb(new Blob(['jpeg'], { type: 'image/jpeg' }));
};

describe('fileToOriginImage downscale', () => {
  it('flattens onto white before drawing (transparent PNG must not go black)', async () => {
    // 2000px wide > MAX_DIMENSION forces the downscale/re-encode path.
    const file = new File(['png-bytes'], 'a.png', { type: 'image/png' });
    await fileToOriginImage(file);
    expect(ops).toEqual(['fill:#fff', 'draw']);
  });
});
