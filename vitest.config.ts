import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Integration suites that need Postgres opt in via their own project config; the default
    // run stays fast and dependency-free so the test-first loop is cheap.
    include: ['packages/*/src/**/*.test.ts', 'apps/*/src/**/*.test.ts', 'apps/*/lib/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', '**/.next/**', '**/e2e/**'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['packages/*/src/**/*.ts', 'apps/*/lib/**/*.ts'],
      exclude: ['**/*.test.ts', '**/index.ts'],
    },
  },
});
