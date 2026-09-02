import { defineWorkspace } from 'vitest/config';

/**
 * Two projects, because the suites have genuinely different isolation needs.
 *
 * `unit` is pure and I/O-free, so its files run in parallel across workers.
 *
 * `db` talks to one real Postgres. Those suites reset the tables they own between tests, which
 * is only safe if no other suite is touching the same database at the same moment — running
 * them in parallel let one truncate `user` while another was inserting rows that referenced it,
 * producing foreign-key failures that appeared and vanished depending on interleaving.
 * `fileParallelism: false` makes them run one file at a time.
 *
 * A suite belongs to `db` by being named `*.db.test.ts`. See CONTRIBUTING.md.
 */

const shared = {
  include: ['packages/*/src/**/*.test.ts', 'apps/*/src/**/*.test.ts', 'apps/*/lib/**/*.test.ts'],
  exclude: ['**/node_modules/**', '**/dist/**', '**/.next/**', '**/e2e/**'],
};

export default defineWorkspace([
  {
    test: {
      ...shared,
      name: 'unit',
      exclude: [...shared.exclude, '**/*.db.test.ts'],
    },
  },
  {
    test: {
      name: 'db',
      include: [
        'packages/*/src/**/*.db.test.ts',
        'apps/*/src/**/*.db.test.ts',
        'apps/*/lib/**/*.db.test.ts',
      ],
      exclude: shared.exclude,
      // One database, one file at a time. See the note above.
      fileParallelism: false,
    },
  },
]);
