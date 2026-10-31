import { describe, expect, it } from 'vitest';
import { QR_QUIET, qrMatrix, qrSvg } from '../qr';

/** QR images of the coupon's «QR-код» card. */

describe('qrMatrix', () => {
  it('encodes the short link as a square code with the three finder patterns', async () => {
    const m = await qrMatrix('https://quest.geohod.ru/go/7KX2M9');
    const n = m.length;
    // 33 characters at level M fit version 3: 29 × 29 modules.
    expect(n).toBe(29);
    expect(m.every((row) => row.length === n)).toBe(true);
    // A finder pattern: a dark 7-module ring, light inside it, a dark 3 × 3 core.
    const finderAt = (top: number, left: number) =>
      [0, 6].every((i) => [...Array(7).keys()].every((j) => m[top + i][left + j] && m[top + j][left + i])) &&
      !m[top + 1][left + 1] &&
      m[top + 3][left + 3];
    expect(finderAt(0, 0)).toBe(true);
    expect(finderAt(0, n - 7)).toBe(true);
    expect(finderAt(n - 7, 0)).toBe(true);
  });
});

describe('qrSvg', () => {
  it('merges each row’s dark runs into one path, inside the quiet zone', () => {
    const svg = qrSvg([
      [true, true, false],
      [false, false, false],
      [true, false, true],
    ]);
    const side = 3 + QR_QUIET * 2;
    expect(svg).toContain(`viewBox="0 0 ${side} ${side}"`);
    expect(svg).toContain(`<rect width="${side}" height="${side}" fill="white"/>`);
    // Row 0: one run of two; row 2: two runs of one; row 1: nothing.
    expect(svg).toContain('d="M4 4h2v1h-2zM4 6h1v1h-1zM6 6h1v1h-1z"');
  });
});
