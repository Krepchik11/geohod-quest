/**
 * Bundle download flow — fetch → IndexedDB store → media precache → done.
 */
import 'fake-indexeddb/auto';
import { describe, expect, it, beforeEach } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import {
  appendFact,
  ensureActiveAttempt,
  getActiveAttempt,
  getBundle,
  getFacts,
  getLatestBundleForQuest,
  __resetQueueForTests,
} from '../queue';
import {
  downloadBundle,
  collectMediaRefs,
  precacheBundleMedia,
  removeBlock,
  removeDownloadedQuest,
  shellAssetUrls,
  storeBundle,
  type DownloadStage,
} from '../download';
import type { BundleWire } from '../api';
import { getSnapshot } from '../goldens';
import { loadQuestSnapshot, type Fact, type QuestSnapshot } from '../shared-model';

const QUEST = 'mystery-fortress-v1';

/** Media refs whose fetch fails (a media host without CORS, a dropped connection)… */
const FAILING = new Set<string>();
/** …and refs the media host answers with this HTTP status instead of the file. */
const STATUS = new Map<string, number>();

/** The media fetch: an error, a status, or the file. */
async function fakeFetch(ref: string): Promise<Response> {
  if (FAILING.has(ref)) throw new TypeError('Failed to fetch');
  return new Response('media', { status: STATUS.get(ref) ?? 200 });
}

/** Minimal in-memory Cache Storage so precache (open → cache.put) is observable — the
 *  only surface `precacheMedia` touches; assertions read each cache's `added` refs. */
class FakeCache {
  added: string[] = [];
  async put(ref: string) {
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
  async delete(name: string) {
    return this.caches.delete(name);
  }
}

function cacheFor(snapshotId: string): FakeCache | undefined {
  return (globalThis.caches as unknown as FakeCacheStorage).caches.get(`quest-bundle-${snapshotId}`);
}

function fact(partial: Partial<Fact> = {}): Fact {
  return {
    type: 'physical_confirmed',
    step_position: 0,
    submitted_value: null,
    local_is_correct: true,
    coins_delta: 0,
    note: null,
    device_id: 'device-a',
    ...partial,
  } as Fact;
}

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory();
  __resetQueueForTests();
  (globalThis as { caches?: unknown }).caches = new FakeCacheStorage();
  globalThis.fetch = fakeFetch as typeof fetch;
  FAILING.clear();
  STATUS.clear();
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

describe('offline completeness (media_complete — the «⭳ офлайн» badge reads it)', () => {
  it('a stored bundle is incomplete until the media precache confirms it', async () => {
    const row = await storeBundle(wireWithMedia('snap-pending'));
    expect(row.media_complete).toBe(false);
  });

  it('a download whose media all reached the cache is complete', async () => {
    await downloadBundle(QUEST, 'p', { getBundle: async () => wireWithMedia('snap-ok') });
    expect((await getBundle('snap-ok'))?.media_complete).toBe(true);
  });

  it('one file that failed to cache leaves it incomplete', async () => {
    FAILING.add('https://m/vid1');
    await downloadBundle(QUEST, 'p', { getBundle: async () => wireWithMedia('snap-part') });
    expect((await getBundle('snap-part'))?.media_complete).toBe(false);
  });

  it('a media host in trouble (5xx) leaves it incomplete — a retry can fix that', async () => {
    STATUS.set('https://m/vid1', 503);
    await downloadBundle(QUEST, 'p', { getBundle: async () => wireWithMedia('snap-5xx') });
    expect((await getBundle('snap-5xx'))?.media_complete).toBe(false);
  });

  it('a file gone for everyone (404) is not owed: offline is no worse than online', async () => {
    STATUS.set('https://m/vid1', 404);
    await downloadBundle(QUEST, 'p', { getBundle: async () => wireWithMedia('snap-404') });
    expect((await getBundle('snap-404'))?.media_complete).toBe(true);
    expect(cacheFor('snap-404')?.added).not.toContain('https://m/vid1');
  });
});

describe('removeDownloadedQuest («Удалить с устройства»)', () => {
  const download = (snapshotId: string, version = 1) =>
    downloadBundle(QUEST, 'p', { getBundle: async () => ({ ...wireWithMedia(snapshotId), snapshot_version: version }) });

  it('removes every downloaded version and its media cache', async () => {
    await download('snap-a', 1);
    await download('snap-b', 2);
    expect(await removeBlock(QUEST)).toBeNull();
    await removeDownloadedQuest(QUEST);
    expect(await getLatestBundleForQuest(QUEST)).toBeNull();
    expect(cacheFor('snap-a')).toBeUndefined();
    expect(cacheFor('snap-b')).toBeUndefined();
  });

  it('refuses while an attempt is running: the download pins its version', async () => {
    await download('snap-a');
    const attempt = await ensureActiveAttempt(QUEST, 'snap-a');
    await appendFact(attempt.attempt_key, fact({ step_position: 0 }));
    expect(await removeBlock(QUEST)).toBe('in-progress');
    await expect(removeDownloadedQuest(QUEST)).rejects.toThrow('in progress');
    expect(await getBundle('snap-a')).not.toBeNull();
  });

  it('a finished quest goes; its attempt is retired, its facts (coins, the finish) stay', async () => {
    await download('snap-a');
    const attempt = await ensureActiveAttempt(QUEST, 'snap-a');
    await appendFact(attempt.attempt_key, fact({ step_position: 0 }));
    await appendFact(attempt.attempt_key, fact({ type: 'attempt_completed', step_position: 1 }));
    await removeDownloadedQuest(QUEST);
    expect(await getBundle('snap-a')).toBeNull();
    // The next open binds afresh to the version it can fetch — never the removed one.
    expect(await getActiveAttempt(QUEST)).toBeNull();
    expect(await getFacts(attempt.attempt_key)).toHaveLength(2);
  });

  it('an opened-but-unplayed quest goes, and its empty attempt with it', async () => {
    await download('snap-a');
    await ensureActiveAttempt(QUEST, 'snap-a');
    await removeDownloadedQuest(QUEST);
    expect(await getActiveAttempt(QUEST)).toBeNull();
  });
});

describe('shellAssetUrls (the player page warmed for offline open)', () => {
  it('collects the tags and the RSC chunk list, deduped, query strings kept', () => {
    const html =
      '<link rel="stylesheet" href="/_next/static/css/app.css?dpl=d1">' +
      '<script src="/_next/static/chunks/main.js" async></script>' +
      '<link rel="preload" href="/_next/static/media/font.woff2" as="font">' +
      '<script>self.__next_f.push([1,"0:[\\"/_next/static/chunks/page-abc.js\\",\\"/_next/static/chunks/main.js\\"]"])</script>' +
      '<img src="/assets/img/hero.png">';
    expect(shellAssetUrls(html)).toEqual([
      '/_next/static/css/app.css?dpl=d1',
      '/_next/static/chunks/main.js',
      '/_next/static/media/font.woff2',
      '/_next/static/chunks/page-abc.js',
    ]);
  });
});
