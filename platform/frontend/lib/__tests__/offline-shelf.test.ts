// @vitest-environment jsdom
/**
 * lib/offline-shelf — what the shop shows with no network: the player's own
 * quests from the remembered catalog/grants and the downloads on the device.
 */
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { putBundle, __resetQueueForTests } from '../queue';
import { getSnapshot } from '../goldens';
import { loadQuestSnapshot } from '../shared-model';
import type { PublishedQuestWire } from '../api';
import { forgetGrants, loadOfflineShelf, rememberCatalog, rememberGrants } from '../offline-shelf';

const SNAPSHOT = loadQuestSnapshot(getSnapshot('mystery-fortress-v1'));

function card(quest_id: string, name: string): PublishedQuestWire {
  return {
    quest_id, name, primary_comic: 'https://media/cover', template_summary: '', description: null,
    pages: null, tasks: null, paid_hints: null, snapshot_version: 1, snapshot_id: `snap-${quest_id}`,
    city: 'Белград', duration: '2 часа', duration_min: 60, distance_km: 5, price: 890, rating_avg: 4.5, rating_count: 3, players: 10,
    complexity: null, age_target: null, tags: [],
  };
}

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory();
  __resetQueueForTests();
  window.localStorage.clear();
});

describe('loadOfflineShelf', () => {
  it('own quests only: remembered grants and downloads, dressed from the remembered catalog', async () => {
    rememberCatalog([card('a', 'Ад Калемегдана'), card('b', 'Ярость Земуна'), card('c', 'Чужой')]);
    rememberGrants('dev:me', new Map([['a', '2026-09-01T00:00:00Z']]));
    await putBundle({
      snapshot_id: 'snap-b', quest_id: 'b', version: 1, snapshot: SNAPSHOT, size_bytes: 1, downloaded_at: '2026-09-02T00:00:00Z',
    });
    const shelf = await loadOfflineShelf('dev:me');
    expect(shelf.quests.map((q) => q.name).sort()).toEqual(['Ад Калемегдана', 'Ярость Земуна']);
    expect([...shelf.owned].sort()).toEqual(['a', 'b']);
    expect(shelf.grantedAt.get('a')).toBe('2026-09-01T00:00:00Z');
  });

  it('a download the catalog never listed gets a card from its own snapshot', async () => {
    await putBundle({
      snapshot_id: 'snap-x', quest_id: 'x', version: 2, snapshot: { ...SNAPSHOT, name: 'Тайна крепости', city: 'Нови Сад' },
      size_bytes: 1, downloaded_at: '2026-09-02T00:00:00Z',
    });
    const [q] = (await loadOfflineShelf('dev:me')).quests;
    expect(q).toMatchObject({ quest_id: 'x', name: 'Тайна крепости', city: 'Нови Сад', snapshot_id: 'snap-x', primary_comic: null });
  });

  it("another identity's remembered grants are not ours, and logout forgets them", async () => {
    rememberCatalog([card('a', 'Ад Калемегдана')]);
    rememberGrants('acc:someone-else', new Map([['a', '2026-09-01T00:00:00Z']]));
    expect((await loadOfflineShelf('dev:me')).quests).toEqual([]);

    rememberGrants('dev:me', new Map([['a', '2026-09-01T00:00:00Z']]));
    forgetGrants();
    expect((await loadOfflineShelf('dev:me')).quests).toEqual([]);
  });
});
