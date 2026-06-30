import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
export const ROOT = resolve(here, '..'); // tools/bubble-import

export const RAW_DIR = resolve(ROOT, 'raw'); // committed: lossless source of truth
export const MEDIA_DIR = resolve(RAW_DIR, 'media'); // committed: downscaled JPEGs
export const GEN_DIR = resolve(ROOT, 'generated'); // gitignored: regenerable artifacts

export const RAW = {
  quests: resolve(RAW_DIR, 'quests.json'),
  pages: resolve(RAW_DIR, 'pages.json'),
  authors: resolve(RAW_DIR, 'authors.json'),
  meta: resolve(RAW_DIR, 'meta.json'),
  mediaMap: resolve(RAW_DIR, 'media-map.json'),
};

export const GEN = {
  bodies: resolve(GEN_DIR, 'bodies'),
  report: resolve(GEN_DIR, 'report.md'),
  load: resolve(GEN_DIR, 'load.sql'),
  rollback: resolve(GEN_DIR, 'rollback.sql'),
};

/** bubble Data API base for the geoquest app. */
export const BUBBLE_BASE = 'https://geoquest.bubbleapps.io/api/1.1/obj';

/** Stable prefix so re-imports upsert the same rows (idempotent). */
export const QUEST_ID_PREFIX = 'bubble-';
export const USER_ID_PREFIX = 'bubble-user-';

/** Image downscale spec — mirrors frontend/lib/image-file.ts. */
export const MAX_DIMENSION = 1280;
export const JPEG_QUALITY = 82;
export const SIZE_TARGET_BYTES = 2.5 * 1024 * 1024;

export function requireToken(): string {
  const t = process.env.BUBBLE_TOKEN;
  if (!t) {
    throw new Error(
      'BUBBLE_TOKEN env var is required for fetch/media (read-only bubble Data API token). ' +
        'It is never committed. Re-running transform/load/report does NOT need it (raw/ is committed).',
    );
  }
  return t;
}

export interface R2Config {
  endpoint: string; // S3 API endpoint (defaults to the account's R2 endpoint)
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  publicBase: string; // public URL base, e.g. https://media.quest.geohod.ru
}

/**
 * R2 config from env for the `upload` stage (mirrors requireToken). All required
 * except R2_ENDPOINT, which defaults to the account's R2 S3 endpoint and can be
 * overridden — e.g. to point at a local MinIO for an end-to-end test.
 */
export function requireR2(): R2Config {
  const get = (k: string): string => {
    const v = process.env[k]?.trim();
    if (!v) {
      throw new Error(
        `${k} env var is required for the R2 upload stage. Set R2_ACCESS_KEY_ID, ` +
          'R2_SECRET_ACCESS_KEY, R2_BUCKET, R2_PUBLIC_BASE_URL and either R2_ACCOUNT_ID ' +
          'or R2_ENDPOINT.',
      );
    }
    return v;
  };
  const endpointOverride = process.env.R2_ENDPOINT?.trim();
  const endpoint = (
    endpointOverride || `https://${get('R2_ACCOUNT_ID')}.r2.cloudflarestorage.com`
  ).replace(/\/+$/, '');
  return {
    endpoint,
    bucket: get('R2_BUCKET'),
    accessKeyId: get('R2_ACCESS_KEY_ID'),
    secretAccessKey: get('R2_SECRET_ACCESS_KEY'),
    publicBase: get('R2_PUBLIC_BASE_URL').replace(/\/+$/, ''),
  };
}

/**
 * Run `main` only when this module is the process entry point, not when it is
 * imported — so importing a stage for its exported helpers/types is
 * side-effect-free (previously, importing media.ts kicked off a download).
 */
export function runAsMain(metaUrl: string, main: () => Promise<unknown>): void {
  if (process.argv[1] && metaUrl === pathToFileURL(process.argv[1]).href) {
    main().catch((e) => {
      console.error(e);
      process.exitCode = 1;
    });
  }
}
