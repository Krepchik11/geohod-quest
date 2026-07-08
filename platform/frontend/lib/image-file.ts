/**
 * Image file → downscaled JPEG Blob for upload to the media store (Cloudflare R2).
 * Downscales through a canvas (≤1280px, JPEG-82) so uploads stay small; the
 * constructor stores the returned R2 URL, not the bytes. Replaces the design's
 * «клик ставит демо-файл» mock.
 *
 * Step images have a stricter contract (4:3, ≤100 KB): decodeImageFile exposes
 * the decoded bitmap so the editor can run the crop UI, and cropToStepImage
 * crops + compresses until the byte budget from lib/image-crop is met.
 */
import { STEP_IMAGE_ASPECT, STEP_IMAGE_MAX_BYTES, type CropRect } from './image-crop';

const MAX_DIMENSION = 1280;
const JPEG_QUALITY = 0.82;
/** Hard cap when canvas downscale is unavailable (keeps localStorage usable). */
const RAW_LIMIT_BYTES = 2.5 * 1024 * 1024;

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('Не удалось прочитать файл'));
    reader.readAsDataURL(file);
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
  dataUrl: string;
}

/** Decode an image file to a bitmap the crop editor can display and measure. */
export async function decodeImageFile(file: File): Promise<DecodedImage> {
  if (!file.type.startsWith('image/')) {
    throw new Error('Нужно изображение PNG или JPG');
  }
  const dataUrl = await readAsDataUrl(file);
  const img = await loadImage(dataUrl);
  if (!img.naturalWidth || !img.naturalHeight) {
    throw new Error('Файл не похож на изображение');
  }
  return { img, width: img.naturalWidth, height: img.naturalHeight, dataUrl };
}

/** Longest edge of the encoded 4:3 step image — plenty for a phone screen. */
const STEP_IMAGE_MAX_WIDTH = 1200;
const STEP_IMAGE_MIN_WIDTH = 320;

/**
 * Crop the source to `rect` (a 4:3 region) and compress to ≤100 KB: first walk
 * the JPEG quality down, then shrink dimensions. Terminates: dimensions fall
 * geometrically and a 320px-wide JPEG at q0.5 is far under the budget.
 */
export async function cropToStepImage(img: HTMLImageElement, rect: CropRect): Promise<Blob> {
  let width = Math.min(Math.round(rect.width), STEP_IMAGE_MAX_WIDTH);
  for (;;) {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = Math.round(width / STEP_IMAGE_ASPECT);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Обрезка недоступна в этом браузере (нет canvas)');
    // JPEG has no alpha — flatten transparent PNGs onto white, not black.
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, rect.x, rect.y, rect.width, rect.height, 0, 0, canvas.width, canvas.height);
    for (const quality of [0.82, 0.72, 0.62, 0.52]) {
      const blob = await new Promise<Blob | null>((resolve) =>
        canvas.toBlob(resolve, 'image/jpeg', quality),
      );
      if (!blob) throw new Error('Не удалось сжать изображение');
      if (blob.size <= STEP_IMAGE_MAX_BYTES) return blob;
    }
    if (width <= STEP_IMAGE_MIN_WIDTH) {
      throw new Error('Не удалось сжать изображение до 100 КБ');
    }
    width = Math.max(STEP_IMAGE_MIN_WIDTH, Math.round(width * 0.75));
  }
}

export async function fileToImageBlob(file: File): Promise<Blob> {
  if (!file.type.startsWith('image/')) {
    throw new Error('Нужно изображение PNG или JPG');
  }
  const raw = await readAsDataUrl(file);
  try {
    const img = await loadImage(raw);
    const scale = Math.min(1, MAX_DIMENSION / Math.max(img.naturalWidth, img.naturalHeight));
    // Already within bounds: upload the original file (a Blob) untouched.
    if (scale === 1 && file.size <= RAW_LIMIT_BYTES) return file;
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('canvas unavailable');
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, 'image/jpeg', JPEG_QUALITY),
    );
    if (!blob) throw new Error('canvas toBlob failed');
    return blob;
  } catch {
    // Canvas unavailable / decode failed: fall back to the original file if small enough.
    if (file.size > RAW_LIMIT_BYTES) {
      throw new Error('Изображение больше 2,5 МБ — сожмите его перед загрузкой');
    }
    return file;
  }
}
