/**
 * Refuse to run the Postgres-backed suites against the database the app uses.
 *
 * Every `*.db.test.ts` suite resets the tables it owns between tests, and `user` sits at the top
 * of a cascade: deleting it takes `chess_account`, and with it every game, every move, every
 * analysis row and every puzzle. That is correct behaviour for a test database and catastrophic
 * for a real one.
 *
 * This has already happened once. `TEST_DATABASE_URL` and `DATABASE_URL` were set to the same
 * Neon branch — fine while that branch was a scratch database, quietly fatal once a real history
 * had been synced into it. A `npm run test:db` run then deleted 4,173 games, 225,803 move
 * evaluations and 8,507 puzzles. Nothing irreplaceable was lost, because everything there derives
 * from Chess.com, but the rebuild cost most of an hour.
 *
 * The lesson is not "be careful with the env file". It is that a destructive default should be
 * impossible to configure, not merely discouraged. This runs before any db suite and throws.
 */

function hostAndDatabase(url: string): string | null {
  try {
    const parsed = new URL(url);
    // Host plus database name. Two branches of the same Neon project differ in host, so this is
    // enough to tell them apart, and it ignores credentials — a rotated password is still the
    // same database.
    return `${parsed.hostname.toLowerCase()}${parsed.pathname.toLowerCase()}`;
  } catch {
    return null;
  }
}

export function assertSeparateTestDatabase(env: NodeJS.ProcessEnv = process.env): void {
  const test = env.TEST_DATABASE_URL;
  if (!test) return; // No test database configured: the suites skip themselves.

  const app = env.DATABASE_URL;
  if (!app) return; // Nothing to collide with.

  const testTarget = hostAndDatabase(test);
  const appTarget = hostAndDatabase(app);

  // An unparseable URL is not something to guess about. Let the suite fail on connect instead.
  if (!testTarget || !appTarget) return;

  if (testTarget === appTarget) {
    throw new Error(
      [
        '',
        'REFUSING TO RUN: TEST_DATABASE_URL and DATABASE_URL point at the same database.',
        '',
        `  both -> ${testTarget}`,
        '',
        'The db suites truncate `user`, which cascades to chess_account -> game -> move,',
        'move_analysis, game_analysis and puzzle. Running them here would delete the',
        'application data.',
        '',
        'Point TEST_DATABASE_URL at a separate branch. In Neon: Branches -> New branch.',
        '',
      ].join('\n'),
    );
  }
}

assertSeparateTestDatabase();
