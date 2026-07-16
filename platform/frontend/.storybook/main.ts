import type { StorybookConfig } from '@storybook/nextjs-vite';

/**
 * Storybook on the Vite-powered Next framework (supports next/link,
 * next/navigation, next/image out of the box). Stories are colocated with
 * their components under app/.
 */
const config: StorybookConfig = {
  framework: '@storybook/nextjs-vite',
  stories: ['../app/**/*.stories.@(ts|tsx)'],
  staticDirs: ['../public'],
};

export default config;
