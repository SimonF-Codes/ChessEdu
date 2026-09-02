import { defineConfig } from 'vitest/config';

/**
 * Which files run, and with what isolation, lives in vitest.workspace.ts — it splits the
 * suites into `unit` (parallel, I/O-free) and `db` (one real Postgres, serial).
 * This file carries only what is shared across both projects.
 */
export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['packages/*/src/**/*.ts', 'apps/*/lib/**/*.ts'],
      exclude: ['**/*.test.ts', '**/index.ts'],
    },
  },
});
