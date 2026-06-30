/**
 * EXTRACT: pull the lossless raw archive from bubble into raw/ (committed).
 * Re-running transform/report/load does NOT need this — raw/ is the source of truth.
 *
 *   BUBBLE_TOKEN=xxx npm run fetch
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { fetchAll } from './bubble.ts';
import { RAW, RAW_DIR, requireToken, runAsMain } from './config.ts';
import type { BubblePage, BubbleQuest, BubbleUser } from './types.ts';

const byId = (a: { _id: string }, b: { _id: string }) => a._id.localeCompare(b._id);

async function writeJson(path: string, data: unknown): Promise<void> {
  await writeFile(path, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

async function main(): Promise<void> {
  const token = requireToken();
  await mkdir(RAW_DIR, { recursive: true });

  console.log('fetching quests…');
  const quests = (await fetchAll<BubbleQuest>('quest', token)).sort(byId);
  console.log('fetching pages…');
  const pages = (await fetchAll<BubblePage>('page', token)).sort(byId);

  const authorIds = [...new Set(quests.map((q) => q.creatorUser).filter(Boolean))] as string[];
  console.log(`fetching ${authorIds.length} authors…`);
  const authors = (
    await fetchAll<BubbleUser>('user', token, [
      { key: '_id', constraint_type: 'in', value: authorIds },
    ])
  ).sort(byId);

  await writeJson(RAW.quests, quests);
  await writeJson(RAW.pages, pages);
  await writeJson(RAW.authors, authors);
  await writeJson(RAW.meta, {
    fetchedAt: new Date().toISOString(),
    source: 'geoquest.bubbleapps.io',
    counts: { quests: quests.length, pages: pages.length, authors: authors.length },
  });

  console.log(
    `raw archive written: ${quests.length} quests, ${pages.length} pages, ${authors.length} authors`,
  );
}

runAsMain(import.meta.url, main);
