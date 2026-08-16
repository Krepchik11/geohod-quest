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
    // The stable app identity: without it, changing start_url would mint a NEW
    // installed app instead of updating the existing one.
    id: '/',
    start_url: '/',
    display: 'standalone',
    background_color: '#ffffff',
    theme_color: '#3B71FE',
    icons: [
      { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
      { src: '/icon-512-maskable.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
    ],
  };
}
