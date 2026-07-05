import type { MetadataRoute } from 'next';

/**
 * §5 per-quest PWA manifest — each OWNED quest installs as its own home-screen
 * app whose scope/start_url is the player route, so the icon opens straight
 * into the game (offline included). The quest product page and the player link
 * this manifest; every other page keeps the global one.
 *
 * Pure functions — the route handler stays a thin shell.
 */

export interface QuestManifestSource {
  quest_id: string;
  name: string;
  snapshot_version: number;
  primary_comic: string | null;
}

/** short_name ≤ 14 chars keeps Android launchers from mid-word clipping. */
export function shortName(name: string): string {
  const limit = 14;
  if (name.length <= limit) return name;
  return `${name.slice(0, limit - 1).trimEnd()}…`;
}

/** Versioned icon URLs on the backend cover→icon endpoint (cached per version). */
export function questIconUrls(questId: string, version: number, apiBase: string): Record<192 | 512, string> {
  const id = encodeURIComponent(questId);
  return {
    192: `${apiBase}/api/quests/${id}/icons/192.png?v=${version}`,
    512: `${apiBase}/api/quests/${id}/icons/512.png?v=${version}`,
  };
}

export function questManifest(q: QuestManifestSource, apiBase: string): MetadataRoute.Manifest {
  const path = `/quest/${encodeURIComponent(q.quest_id)}`;
  // No cover → the backend has nothing to crop; fall back to the global logo
  // icons (logo mark, maskable) rather than a broken image.
  const icons: MetadataRoute.Manifest['icons'] = q.primary_comic
    ? (() => {
        const urls = questIconUrls(q.quest_id, q.snapshot_version, apiBase);
        return [
          { src: urls[192], sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: urls[512], sizes: '512x512', type: 'image/png', purpose: 'maskable' },
          { src: urls[512], sizes: '512x512', type: 'image/png', purpose: 'any' },
        ];
      })()
    : [
        { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
        { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
      ];
  return {
    id: path,
    name: q.name,
    short_name: shortName(q.name),
    start_url: path,
    scope: path,
    display: 'standalone',
    // The paper player's palette — the installed app opens straight into it.
    background_color: '#FBF1E5',
    theme_color: '#3E2C2C',
    icons,
  };
}
