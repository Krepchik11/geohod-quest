/**
 * Authoring a quest image: what the pipeline promises the editor.
 * - a picked file is decoded but NOT uploaded until the crop is confirmed
 *   (a cancelled crop must leave no orphan in the media store);
 * - confirming uploads the uncropped source once and the crop once, and stores
 *   both plus the chosen rect;
 * - re-cropping a stored value reuses the source URL — only the crop is new;
 * - an image with no stored source (uploaded before crop origins existed) is
 *   re-cropped from itself instead of being a dead end.
 * The canvas/network halves are mocked — they are browser-only.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('../image-file', () => ({
  fileToOriginImage: vi.fn(),
  decodeImageUrl: vi.fn(),
  cropToQuestImage: vi.fn(),
}));
vi.mock('../api', () => ({ api: { uploadMedia: vi.fn() } }));

import { beginCropFromFile, beginCropFromValue, commitCrop, sessionRect } from '../image-authoring';
import { cropToQuestImage, decodeImageUrl, fileToOriginImage } from '../image-file';
import { api } from '../api';
import { STEP_IMAGE_MAX_BYTES } from '../image-crop';

const decoded = { img: {} as HTMLImageElement, width: 1000, height: 600, src: 'data:,' };
const SOURCE = new Blob(['source']);
const CROP = new Blob(['crop']);
const RECT = { x: 200, y: 0, width: 800, height: 600 };

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(fileToOriginImage).mockResolvedValue({ blob: SOURCE, decoded });
  vi.mocked(decodeImageUrl).mockResolvedValue(decoded);
  vi.mocked(cropToQuestImage).mockResolvedValue(CROP);
  vi.mocked(api.uploadMedia).mockImplementation(async (blob: Blob) => ({
    url: blob === SOURCE ? '/media/source.jpg' : '/media/crop.jpg',
    hash: 'h',
    content_type: 'image/jpeg',
    size: blob.size,
  }));
});

describe('beginCrop', () => {
  it('a picked file uploads nothing yet and opens on the default 4:3 rect', async () => {
    const session = await beginCropFromFile(new File(['x'], 'a.jpg', { type: 'image/jpeg' }));
    expect(api.uploadMedia).not.toHaveBeenCalled();
    expect(sessionRect(session)).toEqual({ x: 100, y: 0, width: 800, height: 600 });
  });

  it('a stored value reopens its own source on the rect the author chose', async () => {
    const session = await beginCropFromValue({
      url: '/media/crop.jpg',
      origin: { url: '/media/source.jpg', width: 1000, height: 600, rect: RECT },
    });
    expect(decodeImageUrl).toHaveBeenCalledWith('/media/source.jpg');
    expect(sessionRect(session)).toEqual(RECT);
  });

  it('a legacy image with no stored source is re-cropped from itself', async () => {
    const session = await beginCropFromValue({ url: '/media/old.jpg', origin: null });
    expect(decodeImageUrl).toHaveBeenCalledWith('/media/old.jpg');
    expect(sessionRect(session)).toEqual({ x: 100, y: 0, width: 800, height: 600 });
  });

  it('refuses to crop an empty value', async () => {
    await expect(beginCropFromValue({ url: null, origin: null })).rejects.toThrow();
  });
});

describe('commitCrop', () => {
  it('uploads the source and the crop, and stores both with the rect', async () => {
    const session = await beginCropFromFile(new File(['x'], 'a.jpg', { type: 'image/jpeg' }));
    const value = await commitCrop(session, RECT, STEP_IMAGE_MAX_BYTES);

    expect(vi.mocked(cropToQuestImage).mock.calls[0].slice(1)).toEqual([RECT, STEP_IMAGE_MAX_BYTES]);
    expect(vi.mocked(api.uploadMedia).mock.calls.map((c) => c[0])).toEqual([SOURCE, CROP]);
    expect(value).toEqual({
      url: '/media/crop.jpg',
      origin: { url: '/media/source.jpg', width: 1000, height: 600, rect: RECT },
    });
  });

  it('re-crop keeps the stored source — only the crop is uploaded again', async () => {
    const origin = { url: '/media/source.jpg', width: 1000, height: 600, rect: RECT };
    const session = await beginCropFromValue({ url: '/media/crop.jpg', origin });
    const moved = { ...RECT, x: 0 };
    const value = await commitCrop(session, moved, STEP_IMAGE_MAX_BYTES);

    expect(vi.mocked(api.uploadMedia).mock.calls.map((c) => c[0])).toEqual([CROP]);
    expect(value.origin).toEqual({ ...origin, rect: moved });
  });
});
