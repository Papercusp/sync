import { defineConfig } from 'vitest/config';

// jsdom so the renderHook tests for useOwnedSyncEntity have window/document
// (focus/astro listeners) + react-dom. Deps (vitest, @testing-library/react,
// jsdom) resolve via the monorepo root (hoisted), same as the runtime deps.
export default defineConfig({
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.{ts,tsx}'],
  },
});
