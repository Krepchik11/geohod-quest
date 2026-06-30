/** Filesystem adapters: read the committed raw/ archive and resolve media to R2 URLs. */
import { readFileSync } from 'node:fs';
import { RAW } from './config.ts';
import { normalizeUrl, type MediaMap } from './media.ts';
import type { ResolveMedia } from './mapping.ts';
import type { BubblePage, BubbleQuest, BubbleUser } from './types.ts';

export interface RawArchive {
  quests: BubbleQuest[];
  pages: BubblePage[];
  authors: BubbleUser[];
  byId: Map<string, BubblePage>;
}

export function readRaw(): RawArchive {
  const quests = JSON.parse(readFileSync(RAW.quests, 'utf8')) as BubbleQuest[];
  const pages = JSON.parse(readFileSync(RAW.pages, 'utf8')) as BubblePage[];
  const authors = JSON.parse(readFileSync(RAW.authors, 'utf8')) as BubbleUser[];
  return { quests, pages, authors, byId: new Map(pages.map((p) => [p._id, p])) };
}

/**
 * Reads media-map, returns a cached resolver: raw url -> R2 public URL or null.
 * Requires the `upload` stage to have stamped each entry with its r2Url; a valid
 * entry without one means upload has not run — a loud error, not silent media loss.
 */
export function makeMediaResolver(): ResolveMedia {
  const map = JSON.parse(readFileSync(RAW.mediaMap, 'utf8')) as MediaMap;
  const cache = new Map<string, string | null>();
  return (url) => {
    if (!url) return null;
    const key = normalizeUrl(url);
    const hit = cache.get(key);
    if (hit !== undefined) return hit;
    const e = map[key];
    let val: string | null = null;
    if (e && !e.error && e.bytes > 0) {
      if (!e.r2Url) {
        throw new Error(
          `media ${e.file} has no r2Url -- run \`npm run upload\` before transform/report`,
        );
      }
      val = e.r2Url;
    }
    cache.set(key, val);
    return val;
  };
}
