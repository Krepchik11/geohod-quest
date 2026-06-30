/**
 * MEDIA: download every referenced image, downscale to the frontend's spec
 * (<=1280px, JPEG, shrink quality until <=2.5MB), and store under raw/media/.
 * Writes raw/media-map.json (originalUrl -> stored file). Committed for durability.
 *
 * Idempotent: an already-downloaded sha is skipped, so re-runs are cheap.
 *
 *   npm run media
 */
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import Jimp from 'jimp';
import { JPEG_QUALITY, MAX_DIMENSION, MEDIA_DIR, RAW, runAsMain, SIZE_TARGET_BYTES } from './config.ts';
import type { BubblePage, BubbleQuest } from './types.ts';

export interface MediaEntry {
  file: string; // path relative to raw/, e.g. "media/<sha>.jpg"
  sha: string;
  bytes: number;
  width: number;
  height: number;
  error?: string;
  /** R2 object key (sha256 of the file bytes) + public URL, set by `npm run upload`. */
  r2Key?: string;
  r2Url?: string;
}
export type MediaMap = Record<string, MediaEntry>;

/** bubble stores protocol-relative URLs (//host/path). */
export function normalizeUrl(u: string): string {
  return u.startsWith('//') ? `https:${u}` : u;
}

const shaOf = (u: string) => createHash('sha1').update(u).digest('hex').slice(0, 16);

function collectUrls(quests: BubbleQuest[], pages: BubblePage[]): string[] {
  const set = new Set<string>();
  for (const q of quests) if (q.Preview_image) set.add(normalizeUrl(q.Preview_image));
  for (const p of pages) {
    if (p.Image_link) set.add(normalizeUrl(p.Image_link));
    if (p.Hint_Image) set.add(normalizeUrl(p.Hint_Image));
  }
  return [...set].sort();
}

async function downscale(buf: Buffer): Promise<{ out: Buffer; w: number; h: number }> {
  const img = await Jimp.read(buf);
  const { width, height } = img.bitmap;
  if (Math.max(width, height) > MAX_DIMENSION) img.scaleToFit(MAX_DIMENSION, MAX_DIMENSION);
  let q = JPEG_QUALITY;
  let out = await img.quality(q).getBufferAsync(Jimp.MIME_JPEG);
  while (out.length > SIZE_TARGET_BYTES && q > 40) {
    q -= 12;
    out = await img.quality(q).getBufferAsync(Jimp.MIME_JPEG);
  }
  return { out, w: img.bitmap.width, h: img.bitmap.height };
}

async function fetchOne(url: string): Promise<MediaEntry> {
  const sha = shaOf(url);
  const rel = `media/${sha}.jpg`;
  const abs = resolve(MEDIA_DIR, `${sha}.jpg`);
  try {
    if (existsSync(abs)) {
      const img = await Jimp.read(await readFile(abs));
      return { file: rel, sha, bytes: (await stat(abs)).size, width: img.bitmap.width, height: img.bitmap.height };
    }
    const res = await fetch(url);
    if (!res.ok) return { file: rel, sha, bytes: 0, width: 0, height: 0, error: `HTTP ${res.status}` };
    const { out, w, h } = await downscale(Buffer.from(await res.arrayBuffer()));
    await writeFile(abs, out);
    return { file: rel, sha, bytes: out.length, width: w, height: h };
  } catch (e) {
    // Undecodable formats (webp/svg/...) or transient errors: record and continue.
    return { file: rel, sha, bytes: 0, width: 0, height: 0, error: String((e as Error).message || e) };
  }
}

export async function pool<T, R>(
  items: T[],
  n: number,
  fn: (t: T, i: number) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      for (let j = i++; j < items.length; j = i++) out[j] = await fn(items[j]!, j);
    }),
  );
  return out;
}

async function main(): Promise<void> {
  await mkdir(MEDIA_DIR, { recursive: true });
  const quests = JSON.parse(await readFile(RAW.quests, 'utf8')) as BubbleQuest[];
  const pages = JSON.parse(await readFile(RAW.pages, 'utf8')) as BubblePage[];
  const urls = collectUrls(quests, pages);
  console.log(`downloading ${urls.length} unique images…`);

  let done = 0;
  const entries = await pool(urls, 8, async (url) => {
    const e = await fetchOne(url);
    if (++done % 50 === 0) console.log(`  ${done}/${urls.length}`);
    return [url, e] as const;
  });

  const map: MediaMap = Object.fromEntries(entries);
  await writeFile(RAW.mediaMap, JSON.stringify(map, null, 2) + '\n', 'utf8');

  const failed = entries.filter(([, e]) => e.error);
  const totalMb = entries.reduce((s, [, e]) => s + e.bytes, 0) / 1024 / 1024;
  console.log(`media: ${urls.length - failed.length} ok, ${failed.length} failed, ${totalMb.toFixed(1)} MB total`);
  for (const [u, e] of failed) console.log(`  FAILED ${e.error}: ${u}`);
}

runAsMain(import.meta.url, main);
