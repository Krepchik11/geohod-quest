/**
 * Authoring a quest image: the sequence between «автор выбрал файл» and «в теле
 * лежит кадр и его исходник». Lives here, not in the editor component, so the
 * ordering guarantees (source uploaded once, crop re-uploaded on every edit) are
 * stated in one place instead of inside JSX.
 *
 * Geometry is in image-crop.ts, the canvas half in image-file.ts; this module is
 * the seam between them and the media API.
 */
import { api } from './api';
import type { CtorImageOrigin, CtorImageValue } from './constructor-model';
import { startCropRect, type CropRect } from './image-crop';
import { cropToQuestImage, decodeImageUrl, fileToOriginImage, type DecodedImage } from './image-file';

/**
 * An open crop editor: the decoded source plus how to name it once the author
 * confirms. A freshly picked file is held as a Blob and uploaded only on
 * confirm — a cancelled crop must not leave an orphan in the media store.
 */
export interface CropSession {
  decoded: DecodedImage;
  origin: { url: string } | { blob: Blob };
  /** Rect to open on: the author's previous choice, if this source has one. */
  saved: CropRect | null;
}

/** Автор выбрал файл: исходник ещё не в хранилище, рамка — по умолчанию. */
export async function beginCropFromFile(file: File): Promise<CropSession> {
  const { blob, decoded } = await fileToOriginImage(file);
  return { decoded, origin: { blob }, saved: null };
}

/**
 * Автор кликнул по готовому изображению: кадрируем его исходник. У картинок
 * старше кадрирования исходника нет — тогда исходник само изображение, и
 * обложку любой пропорции всё равно можно скадрировать в 4:3, не разыскивая
 * исходный файл.
 */
export async function beginCropFromValue(value: CtorImageValue): Promise<CropSession> {
  const url = value.origin?.url ?? value.url;
  if (!url) throw new Error('Нечего кадрировать: изображение не задано');
  return { decoded: await decodeImageUrl(url), origin: { url }, saved: value.origin?.rect ?? null };
}

/** Рамка, на которой открывается редактор для этой сессии. */
export function sessionRect(session: CropSession): CropRect {
  return startCropRect(session.decoded.width, session.decoded.height, session.saved);
}

/**
 * Автор подтвердил рамку: кодируем кадр и раскладываем оба объекта в хранилище.
 * Кодирование не зависит от загрузки исходника — идут параллельно, чтобы автор
 * не ждал два round-trip'а подряд.
 */
export async function commitCrop(
  session: CropSession,
  rect: CropRect,
  maxBytes: number,
): Promise<CtorImageValue> {
  const origin = session.origin;
  const originUrl = 'url' in origin
    ? Promise.resolve(origin.url)
    : api.uploadMedia(origin.blob).then((r) => r.url);
  const cropUrl = cropToQuestImage(session.decoded.img, rect, maxBytes)
    .then((blob) => api.uploadMedia(blob))
    .then((r) => r.url);
  const [url, crop] = await Promise.all([originUrl, cropUrl]);
  const stored: CtorImageOrigin = {
    url,
    width: session.decoded.width,
    height: session.decoded.height,
    rect,
  };
  return { url: crop, origin: stored };
}
