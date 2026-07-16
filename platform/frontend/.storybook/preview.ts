import type { Preview } from '@storybook/nextjs-vite';

// The app loads its styles globally from app/layout.tsx — mirror that list so
// components render with their real design system. (next/font CSS variables
// like --font-geist-sans are absent here; every font-family declares Inter /
// system fallbacks, so type renders close to production.)
import '../app/globals.css';
import '../app/styles/player-paper.css';
import '../app/styles/commerce.css';
import '../app/styles/myquests.css';
import '../app/styles/admin-ctor.css';
import '../app/styles/ctor-workspace.css';
import '../app/styles/ctor-dashboard.css';
import '../app/styles/admin-users.css';
import '../app/styles/admin-shell.css';
import '../app/styles/admin-page.css';
import '../app/styles/admin-coupons.css';
import '../app/styles/admin-features.css';
import '../app/styles/admin-stats.css';

const preview: Preview = {
  parameters: {
    layout: 'fullscreen',
  },
};

export default preview;
