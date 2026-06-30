/**
 * Image file → downscaled JPEG Blob for upload to the media store (Cloudflare R2).
 * Downscales through a canvas (≤1280px, JPEG-82) so uploads stay small; the
 * constructor stores the returned R2 URL, not the bytes. Replaces the design's
 * «клик ставит демо-файл» mock.
 */

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
