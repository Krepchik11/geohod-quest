/**
 * UPLOAD: push every downscaled image in raw/media/ to Cloudflare R2,
 * content-addressed by sha256(bytes), and stamp the public URL back into
 * raw/media-map.json (consumed by transform/report). Idempotent: an object that
 * already exists (HEAD 200) is not re-uploaded, so re-runs are cheap.
 *
 * Networked stage — run AFTER `media`, BEFORE `transform`:
 *
 *   R2_ACCOUNT_ID=… R2_ACCESS_KEY_ID=… R2_SECRET_ACCESS_KEY=… \
 *   R2_BUCKET=… R2_PUBLIC_BASE_URL=https://media.quest.geohod.ru \
 *   npm run upload
 *
 * The sha256(bytes) key matches the backend's media store, so the same bytes
 * resolve to the same object regardless of which path uploaded them.
 */
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { AwsClient } from 'aws4fetch';
import { RAW, RAW_DIR, requireR2, runAsMain } from './config.ts';
import { pool, type MediaMap } from './media.ts';

const sha256 = (buf: Buffer): string => createHash('sha256').update(buf).digest('hex');

async function main(): Promise<void> {
  const r2 = requireR2();
  const aws = new AwsClient({
    accessKeyId: r2.accessKeyId,
    secretAccessKey: r2.secretAccessKey,
    region: 'auto',
    service: 's3',
  });

  const map = JSON.parse(await readFile(RAW.mediaMap, 'utf8')) as MediaMap;
  // Real images only: skip download failures and zero-byte stubs (they resolve to
  // null in the body, exactly as before).
  const entries = Object.values(map).filter((e) => !e.error && e.bytes > 0);
  console.log(`uploading ${entries.length} images to R2 bucket "${r2.bucket}"…`);

  let uploaded = 0;
  let skipped = 0;
  let done = 0;
  await pool(entries, 8, async (e) => {
    const bytes = await readFile(resolve(RAW_DIR, e.file));
    const key = sha256(bytes);
    const objUrl = `${r2.endpoint}/${r2.bucket}/${key}`;
    // Content-addressed → identical bytes already in the bucket need no re-upload.
    const head = await aws.fetch(objUrl, { method: 'HEAD' });
    if (head.status === 200) {
      skipped++;
    } else {
      const put = await aws.fetch(objUrl, {
        method: 'PUT',
        body: bytes,
        headers: { 'Content-Type': 'image/jpeg' },
      });
      if (!put.ok) {
        throw new Error(`R2 PUT ${key} (${e.file}) failed: ${put.status} ${await put.text()}`);
      }
      uploaded++;
    }
    // Mutates the live map object (Object.values returns references), so the
    // single writeFile below persists every stamp.
    e.r2Key = key;
    e.r2Url = `${r2.publicBase}/${key}`;
    if (++done % 50 === 0) console.log(`  ${done}/${entries.length}`);
  });

  await writeFile(RAW.mediaMap, JSON.stringify(map, null, 2) + '\n', 'utf8');
  console.log(`R2: ${uploaded} uploaded, ${skipped} already present; raw/media-map.json updated.`);
}

runAsMain(import.meta.url, main);
