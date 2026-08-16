/**
 * The browser half of the 4:3 quest-image pipeline (the geometry lives in
 * image-crop.ts). Every constructor image is authored the same way:
 *
 *   file → fileToOriginImage (downscaled, UNCROPPED source, uploaded once)
 *        → crop rect chosen in the source's own pixel space
 *        → cropToQuestImage (4:3, ≤ the role's byte budget, uploaded)
 *
 * Keeping the source lets the author reopen the crop later — decodeImageUrl
 * brings it back — instead of re-uploading the file to move the frame.
 */
import { QUEST_IMAGE_ASPECT, byteBudgetLabel, type CropRect } from './image-crop';

const MAX_DIMENSION = 1280;
const JPEG_QUALITY = 0.82;
/** Hard cap when canvas downscale is unavailable (keeps localStorage usable). */
const RAW_LIMIT_BYTES = 2.5 * 1024 * 1024;

function readAsDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('Не удалось прочитать файл'));
    reader.readAsDataURL(blob);
  });
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Файл не похож на изображение'));
    img.src = src;
  });
}

export interface DecodedImage {
  img: HTMLImageElement;
  width: number;
  height: number;
  /** What an `<img>` in the crop editor can render (a data URL). */
  src: string;
}

async function decodeBlob(blob: Blob): Promise<DecodedImage> {
  const src = await readAsDataUrl(blob);
  const img = await loadImage(src);
  if (!img.naturalWidth || !img.naturalHeight) {
    throw new Error('Файл не похож на изображение');
  }
  return { img, width: img.naturalWidth, height: img.naturalHeight, src };
}

/**
 * Bring a stored source back for re-cropping. Fetched (not assigned to
 * `img.src`) on purpose: a data URL is same-origin, so the canvas never gets
 * tainted by a cross-origin media host — and no crossOrigin/cache interplay can
 * make the crop fail after the same URL was displayed as a plain preview.
 */
export async function decodeImageUrl(url: string): Promise<DecodedImage> {
  const res = await fetch(url, { mode: 'cors' });
  if (!res.ok) throw new Error('Не удалось загрузить исходник изображения');
  return decodeBlob(await res.blob());
}

/**
 * The uncropped source kept next to a cropped image: downscaled for upload and
 * decoded, so every crop rect lives in the SAME pixel space that a later
 * re-crop will see. A file already within bounds is uploaded as-is and reuses
 * the decode we just did — the common case costs exactly one decode.
 */
export async function fileToOriginImage(file: File): Promise<{ blob: Blob; decoded: DecodedImage }> {
  if (!file.type.startsWith('image/')) {
    throw new Error('Нужно изображение PNG или JPG');
  }
  const decoded = await decodeBlob(file);
  const scale = Math.min(1, MAX_DIMENSION / Math.max(decoded.width, decoded.height));
  if (scale === 1 && file.size <= RAW_LIMIT_BYTES) return { blob: file, decoded };
  const blob = await downscale(decoded, scale);
  return { blob, decoded: await decodeBlob(blob) };
}

/** JPEG has no alpha — flatten transparent sources onto white, not black. */
function flattenWhite(ctx: CanvasRenderingContext2D, width: number, height: number): void {
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, width, height);
}

/** Re-encode at `scale` (≤1) as JPEG — the source upload, no crop applied. */
async function downscale(decoded: DecodedImage, scale: number): Promise<Blob> {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(decoded.width * scale));
  canvas.height = Math.max(1, Math.round(decoded.height * scale));
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Обрезка недоступна в этом браузере (нет canvas)');
  flattenWhite(ctx, canvas.width, canvas.height);
  ctx.drawImage(decoded.img, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, 'image/jpeg', JPEG_QUALITY),
  );
  if (!blob) throw new Error('Не удалось сжать изображение');
  return blob;
}

/** Longest edge of the encoded 4:3 image — plenty for a phone screen. */
const QUEST_IMAGE_MAX_WIDTH = 1200;
const QUEST_IMAGE_MIN_WIDTH = 320;

/**
 * Crop the source to `rect` (a 4:3 region) and compress to ≤`maxBytes`: first
 * walk the JPEG quality down, then shrink dimensions. Terminates: dimensions
 * fall geometrically and a 320px-wide JPEG at q0.5 is far under any budget.
 */
export async function cropToQuestImage(
  img: HTMLImageElement,
  rect: CropRect,
  maxBytes: number,
): Promise<Blob> {
  let width = Math.min(Math.round(rect.width), QUEST_IMAGE_MAX_WIDTH);
  // One canvas for every shrink step — resizing it is a resize, not a new surface.
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Обрезка недоступна в этом браузере (нет canvas)');
  for (;;) {
    canvas.width = width;
    canvas.height = Math.round(width / QUEST_IMAGE_ASPECT);
    flattenWhite(ctx, canvas.width, canvas.height);
    ctx.drawImage(img, rect.x, rect.y, rect.width, rect.height, 0, 0, canvas.width, canvas.height);
    for (const quality of [JPEG_QUALITY, 0.72, 0.62, 0.52]) {
      const blob = await new Promise<Blob | null>((resolve) =>
        canvas.toBlob(resolve, 'image/jpeg', quality),
      );
      if (!blob) throw new Error('Не удалось сжать изображение');
      if (blob.size <= maxBytes) return blob;
    }
    if (width <= QUEST_IMAGE_MIN_WIDTH) {
      throw new Error(`Не удалось сжать изображение до ${byteBudgetLabel(maxBytes)}`);
    }
    width = Math.max(QUEST_IMAGE_MIN_WIDTH, Math.round(width * 0.75));
  }
}
