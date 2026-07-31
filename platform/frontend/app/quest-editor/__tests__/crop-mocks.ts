import { vi } from 'vitest';
import type { CropRect } from '../../../lib/image-crop';

/**
 * Fixtures for tests that render an ImageZone. The crop pipeline is browser-only
 * (canvas + FileReader), so every such test stubs lib/image-authoring the same
 * way. One copy, shared via
 *   vi.mock('../../../lib/image-authoring', async (orig) =>
 *     cropAuthoringMock(await orig<typeof import('../../../lib/image-authoring')>()));
 */
export function cropAuthoringMock<T extends object>(actual: T) {
  return {
    ...actual,
    beginCropFromFile: vi.fn(),
    beginCropFromValue: vi.fn(),
    commitCrop: vi.fn(),
  };
}

/** jsdom ships no ResizeObserver; the crop frame measures itself with one. */
export function installResizeObserver(): void {
  class ResizeObserverStub {
    observe() {}
    disconnect() {}
  }
  globalThis.ResizeObserver ??= ResizeObserverStub as unknown as typeof ResizeObserver;
}

/** A decoded 1000×600 source — the shape `beginCrop*` resolves with. */
export const SOURCE = { img: {} as HTMLImageElement, width: 1000, height: 600, src: 'blob:src' };

export const cropSession = (saved: CropRect | null = null) =>
  ({ decoded: SOURCE, origin: { url: '/media/source.jpg' }, saved });

/** A stored image: the 4:3 crop plus the uncropped source it came from. */
export const filledImage = (name: string) => ({
  url: `/media/${name}.jpg`,
  origin: {
    url: `/media/${name}-source.jpg`,
    width: 1000,
    height: 600,
    rect: { x: 200, y: 0, width: 800, height: 600 },
  },
});
