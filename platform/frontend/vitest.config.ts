import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // globals gives @testing-library/react its afterEach auto-cleanup hook.
    globals: true,
    environment: 'node', // per-file jsdom via // @vitest-environment jsdom
  },
});
