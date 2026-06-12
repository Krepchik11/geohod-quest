/**
 * Image file → data URL for the constructor (real uploads replace the design's
 * «клик ставит демо-файл» mock). Downscales through a canvas so drafts stay
 * within the localStorage quota and the ≤5 МБ bundle target.
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

export async function fileToImageDataUrl(file: File): Promise<string> {
  if (!file.type.startsWith('image/')) {
    throw new Error('Нужно изображение PNG или JPG');
  }
  const raw = await readAsDataUrl(file);
  try {
    const img = await loadImage(raw);
    const scale = Math.min(1, MAX_DIMENSION / Math.max(img.naturalWidth, img.naturalHeight));
    if (scale === 1 && raw.length <= RAW_LIMIT_BYTES) return raw;
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('canvas unavailable');
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/jpeg', JPEG_QUALITY);
  } catch {
    if (raw.length > RAW_LIMIT_BYTES) {
      throw new Error('Изображение больше 2,5 МБ — сожмите его перед загрузкой');
    }
    return raw;
  }
}
