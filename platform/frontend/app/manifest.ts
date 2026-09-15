import type { MetadataRoute } from 'next';

/**
 * Web app manifest (installability — the delivery model for street play).
 * Colors from the site system: navy-blue accent #3B71FE on white.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'GEOHOD QUEST',
    short_name: 'GEOHOD',
    description: 'Городские квесты — играйте офлайн, монеты и прогресс синхронизируются сами.',
    // The stable app identity. Without an id it defaults to start_url, and the
    // app shipped years of installs with start_url /my-quests — so THAT value
    // is the identity, frozen here forever. Changing it would orphan existing
    // installs as a "different app"; start_url below is free to move.
    id: '/my-quests',
    start_url: '/',
    display: 'standalone',
    background_color: '#ffffff',
    theme_color: '#3B71FE',
    // The maskable pair carries an opaque ground on purpose: the launcher fills
    // its mask from the image, so a transparent one is punched through to
    // nothing. Both sizes are listed because a device that only needs 192 would
    // otherwise downscale the 512 and smear the strokes.
    icons: [
      { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
      { src: '/icon-192-maskable.png', sizes: '192x192', type: 'image/png', purpose: 'maskable' },
      { src: '/icon-512-maskable.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
    ],
  };
}
