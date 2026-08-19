import { sharedHostWorkerCap } from '@papercusp/test-config/vitest-config';
import { defineConfig } from 'vitest/config';

// jsdom so the renderHook tests for useOwnedSyncEntity have window/document
// (focus/astro listeners) + react-dom. Deps (vitest, @testing-library/react,
// jsdom) resolve via the monorepo root (hoisted), same as the runtime deps.
export default defineConfig({
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.{ts,tsx}'],
    // Same shared-box worker cap the @papercusp/test-config builder applies.
    // Vitest 4 refuses to run projects that share a sequence.groupOrder with
    // DIFFERENT maxWorkers, so every project in the root topology must agree —
    // and an uncapped fork pool on this shared box is the wrong side to agree on.
    ...sharedHostWorkerCap(),
  },
});
