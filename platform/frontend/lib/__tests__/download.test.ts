/**
 * Bundle download flow — fetch → IndexedDB store → media precache → done.
 */
import 'fake-indexeddb/auto';
import { describe, expect, it, beforeEach } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { getBundle, getLatestBundleForQuest, __resetQueueForTests } from '../queue';
import { downloadBundle, collectMediaRefs, precacheBundleMedia, type DownloadStage } from '../download';
import type { BundleWire } from '../api';
import { getSnapshot } from '../goldens';
import { loadQuestSnapshot, type QuestSnapshot } from '../shared-model';

const QUEST = 'mystery-fortress-v1';

/** Minimal in-memory Cache Storage so precache (open → cache.add) is observable — the
 *  only surface `precacheMedia` touches; assertions read each cache's `added` refs. */
class FakeCache {
  added: string[] = [];
  async add(ref: string) {
    this.added.push(ref);
  }
}
class FakeCacheStorage {
  caches = new Map<string, FakeCache>();
  async open(name: string) {
    let c = this.caches.get(name);
    if (!c) this.caches.set(name, (c = new FakeCache()));
    return c;
  }
}

function cacheFor(snapshotId: string): FakeCache | undefined {
  return (globalThis.caches as unknown as FakeCacheStorage).caches.get(`quest-bundle-${snapshotId}`);
}

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory();
  __resetQueueForTests();
  (globalThis as { caches?: unknown }).caches = new FakeCacheStorage();
});

/** Cross-origin cover URL carried by the bundle envelope (post-R2 shape). */
const COVER = 'https://api.quest.geohod.ru/api/media/coverhash';

function stubApi(snapshotId = 'snap-v1', version = 1) {
  return {
    getBundle: async (): Promise<BundleWire> => ({
      quest_id: QUEST,
      snapshot_id: snapshotId,
      snapshot_version: version,
      primary_comic: null,
      snapshot: getSnapshot(QUEST) as unknown,
    }),
  };
}

/** A synthetic wire exercising every media-bearing field (the goldens stub media). */
function wireWithMedia(snapshotId = 'snap-m'): BundleWire {
  return {
    quest_id: QUEST,
    snapshot_id: snapshotId,
    snapshot_version: 1,
    primary_comic: COVER,
    snapshot: {
      golden_id: 'g',
      name: 'n',
      snapshot_version: 1,
      steps: [
        { template: 'task_no', media: { task: 'https://m/task1' }, rich_content: { title: 't', main_text: '' }, completion: { mode: 'physical' } },
        {
          template: 'video',
          media: { video: { ref: 'https://m/vid1' } },
          rich_content: { title: 'v', main_text: '' },
          completion: { mode: 'physical' },
          supporting: {
            media_video: 'https://m/mv1',
            bonus_animation: { asset_ref: 'https://m/anim1', voice_ref: 'https://m/voice1' },
          },
        },
      ],
    },
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
    const failing = { getBundle: async (): Promise<BundleWire> => { throw new Error('403 no grant'); } };
    await expect(downloadBundle(QUEST, 'demo-player', failing)).rejects.toThrow('403');
    expect(await getLatestBundleForQuest(QUEST)).toBeNull();
  });

  it('precaches the envelope cover (wire.primary_comic) alongside snapshot media — the offline-cover fix', async () => {
    await downloadBundle(QUEST, 'p', { getBundle: async () => wireWithMedia('snap-cov') });
    const cache = cacheFor('snap-cov');
    expect(cache?.added).toContain(COVER);
    expect(cache?.added).toContain('https://m/task1');
  });
});

describe('collectMediaRefs', () => {
  it('collects unique cross-origin (R2) media URLs, skipping relative + data: refs', () => {
    const snapshot = {
      steps: [
        { media: { task: 'https://media.x/aaa', character: '/assets/local.png' } },
        { media: { task: 'https://media.x/aaa', hint: 'data:image/jpeg;base64,zzz' } }, // dup + data:
        { media: { atmosphere: 'https://media.x/bbb' } },
        { media: {} },
      ],
    } as unknown as QuestSnapshot;
    const refs = collectMediaRefs(snapshot);
    // R2 URLs only (SWR can't reach them); the `/assets` ref is the shell cache's job
    // and `data:` is already inline in the JSON. Deduped.
    expect([...refs].sort()).toEqual(['https://media.x/aaa', 'https://media.x/bbb']);
  });

  it('collects video, inline media_video, bonus animation and voice refs (every media field)', () => {
    const snapshot = loadQuestSnapshot(wireWithMedia().snapshot);
    expect([...collectMediaRefs(snapshot)].sort()).toEqual([
      'https://m/anim1',
      'https://m/mv1',
      'https://m/task1',
      'https://m/vid1',
      'https://m/voice1',
    ]);
  });
});

describe('precacheBundleMedia', () => {
  it('skips a non-http cover token rather than caching a bogus key', async () => {
    const snap = loadQuestSnapshot(wireWithMedia('snap-d').snapshot);
    await precacheBundleMedia('snap-d', snap, 'comic-token');
    expect(cacheFor('snap-d')?.added).not.toContain('comic-token');
  });

  it('does not duplicate a cover that is already a snapshot media ref', async () => {
    const snap = loadQuestSnapshot(wireWithMedia('snap-e').snapshot);
    await precacheBundleMedia('snap-e', snap, 'https://m/task1');
    const added = cacheFor('snap-e')?.added ?? [];
    expect(added.filter((u) => u === 'https://m/task1')).toHaveLength(1);
  });
});
