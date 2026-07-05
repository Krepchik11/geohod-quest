import { describe, it, expect } from 'vitest';
import { questManifest, shortName, questIconUrls } from '../pwa';

/**
 * §5 per-quest PWA — the manifest a quest page/player links so an OWNED quest
 * installs as its own home-screen app opening straight into the game.
 */
describe('questManifest', () => {
  const base = {
    quest_id: 'q1',
    name: 'Тайны старого Белграда',
    snapshot_version: 4,
    primary_comic: 'https://media.example/abc',
  };

  it('scopes id/start_url/scope to the quest and uses the paper palette', () => {
    const m = questManifest(base, 'https://api.example');
    expect(m.id).toBe('/quest/q1');
    expect(m.start_url).toBe('/quest/q1');
    expect(m.scope).toBe('/quest/q1');
    expect(m.display).toBe('standalone');
    expect(m.background_color).toBe('#FBF1E5');
    expect(m.theme_color).toBe('#3E2C2C');
    expect(m.name).toBe('Тайны старого Белграда');
  });

  it('icons come from the cover endpoint, cache-keyed by version', () => {
    const m = questManifest(base, 'https://api.example');
    expect(m.icons).toEqual([
      { src: 'https://api.example/api/quests/q1/icons/192.png?v=4', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: 'https://api.example/api/quests/q1/icons/512.png?v=4', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
      { src: 'https://api.example/api/quests/q1/icons/512.png?v=4', sizes: '512x512', type: 'image/png', purpose: 'any' },
    ]);
  });

  it('falls back to the global logo icons when the quest has no cover', () => {
    const m = questManifest({ ...base, primary_comic: null }, 'https://api.example');
    expect(m.icons?.[0].src).toBe('/icon-192.png');
  });

  it('encodes the quest id in urls', () => {
    const m = questManifest({ ...base, quest_id: 'q 1/х' }, 'https://api.example');
    expect(m.start_url).toBe('/quest/q%201%2F%D1%85');
  });
});

describe('shortName', () => {
  it('keeps short titles and truncates long ones with an ellipsis', () => {
    expect(shortName('Земун')).toBe('Земун');
    expect(shortName('Тайны старого Белграда')).toBe('Тайны старого…');
  });
});

describe('questIconUrls', () => {
  it('builds versioned backend urls', () => {
    expect(questIconUrls('q1', 4, 'https://api.example')[192]).toBe(
      'https://api.example/api/quests/q1/icons/192.png?v=4',
    );
  });
});
