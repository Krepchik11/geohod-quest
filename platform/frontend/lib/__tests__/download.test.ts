/**
 * Bundle download flow — fetch → IndexedDB store → (cache) → done.
 */
import 'fake-indexeddb/auto';
import { describe, expect, it, beforeEach } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { getBundle, getLatestBundleForQuest, __resetQueueForTests } from '../queue';
import { downloadBundle, collectMediaRefs, type DownloadStage } from '../download';
import { getSnapshot } from '../goldens';

const QUEST = 'mystery-fortress-v1';

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory();
  __resetQueueForTests();
});

function stubApi(snapshotId = 'snap-v1', version = 1) {
  return {
    getBundle: async () => ({
      quest_id: QUEST,
      snapshot_id: snapshotId,
      snapshot_version: version,
      snapshot: getSnapshot(QUEST) as unknown,
    }),
  };
}

describe('downloadBundle', () => {
  it('stores the frozen snapshot keyed by snapshot_id and reports stages in order', async () => {
    const stages: DownloadStage[] = [];
    const row = await downloadBundle(QUEST, 'demo-player', stubApi(), (s) => stages.push(s));
    expect(stages).toEqual(['fetching', 'storing', 'caching', 'done']);
    expect(row.size_bytes).toBeGreaterThan(0);
    const stored = await getBundle('snap-v1');
    expect(stored?.quest_id).toBe(QUEST);
    expect(stored?.snapshot.steps.length).toBeGreaterThan(0);
  });

  it('a newer version stores alongside the old (version freeze — no overwrite)', async () => {
    await downloadBundle(QUEST, 'demo-player', stubApi('snap-v1', 1));
    await downloadBundle(QUEST, 'demo-player', stubApi('snap-v2', 2));
    expect(await getBundle('snap-v1')).not.toBeNull();
    expect((await getLatestBundleForQuest(QUEST))?.snapshot_id).toBe('snap-v2');
  });

  it('a failed fetch stores nothing', async () => {
    const failing = { getBundle: async () => { throw new Error('403 no grant'); } };
    await expect(downloadBundle(QUEST, 'demo-player', failing)).rejects.toThrow('403');
    expect(await getLatestBundleForQuest(QUEST)).toBeNull();
  });
});

describe('collectMediaRefs', () => {
  it('collects unique same-origin refs from step media', () => {
    const refs = collectMediaRefs(getSnapshot(QUEST));
    expect(Array.isArray(refs)).toBe(true);
    expect(refs.every((r) => r.startsWith('/'))).toBe(true);
    expect(new Set(refs).size).toBe(refs.length);
  });
});
