/**
 * QR images for the coupon's «QR-код» card. The matrix
 * comes from `qrcode-generator`, loaded on demand — only that admin card
 * needs it. The SVG (print shop) and the PNG (office printer) are drawn here
 * from the matrix: black on white with the standard quiet zone of four
 * modules, which scanners need around the code.
 */

/** Dark modules, row by row. */
export type QrMatrix = boolean[][];

/** Modules of white margin around the code (the QR standard's quiet zone). */
export const QR_QUIET = 4;

/**
 * Encode `text` at error correction level M: the code still reads with some
 * 15% of it scuffed or covered — enough for a sticker on a counter.
 */
export async function qrMatrix(text: string): Promise<QrMatrix> {
  const { default: qrcode } = await import('qrcode-generator');
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  const n = qr.getModuleCount();
  return Array.from({ length: n }, (_, row) =>
    Array.from({ length: n }, (_, col) => qr.isDark(row, col)),
  );
}

/** Side of the image in modules, the quiet zone included. */
const sideOf = (matrix: QrMatrix) => matrix.length + QR_QUIET * 2;

/**
 * A print-ready SVG: one path with each row's dark runs merged, crisp edges
 * at any size. Pure black on white — scanners read contrast, not brand colours.
 */
export function qrSvg(matrix: QrMatrix): string {
  const side = sideOf(matrix);
  let path = '';
  matrix.forEach((row, y) => {
    let x = 0;
    while (x < row.length) {
      if (!row[x]) {
        x += 1;
        continue;
      }
      let end = x;
      while (end < row.length && row[end]) end += 1;
      path += `M${x + QR_QUIET} ${y + QR_QUIET}h${end - x}v1h-${end - x}z`;
      x = end;
    }
  });
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${side} ${side}" shape-rendering="crispEdges">` +
    `<rect width="${side}" height="${side}" fill="white"/><path d="${path}" fill="black"/></svg>`
  );
}

/**
 * A PNG at most `px` pixels wide for an office printer. Each module is a
 * whole number of pixels, so no edge is blurred by resampling.
 */
export function qrPng(matrix: QrMatrix, px: number): Promise<Blob> {
  const side = sideOf(matrix);
  const scale = Math.max(1, Math.floor(px / side));
  const canvas = document.createElement('canvas');
  canvas.width = side * scale;
  canvas.height = side * scale;
  const ctx = canvas.getContext('2d');
  if (!ctx) return Promise.reject(new Error('canvas 2d is unavailable'));
  ctx.fillStyle = 'white';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = 'black';
  matrix.forEach((row, y) =>
    row.forEach((dark, x) => {
      if (dark) ctx.fillRect((x + QR_QUIET) * scale, (y + QR_QUIET) * scale, scale, scale);
    }),
  );
  return new Promise((resolve, reject) =>
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('PNG encoding failed'))), 'image/png'),
  );
}

/** Hand `blob` to the browser's file save under `filename` (no navigation). */
export function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
