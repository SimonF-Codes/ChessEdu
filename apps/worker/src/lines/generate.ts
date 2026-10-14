import { isNotNull } from 'drizzle-orm';

import {
  DEFAULT_FAMILY_COUNT,
  type FacedReplies,
  type LineSpec,
  PONZIANI,
  chooseOpenings,
  defaultBook,
  familyLabel,
  familyStandings,
  generateLines,
  lineDepthFor,
  plyLabel,
} from '@chessedu/chess';
import { type Database, createDatabase, schema } from '@chessedu/db';

import { Engine } from '../engine';
import { loadFacedReplies, loadFamilyRecords } from './history';
import { saveGeneratedLines } from './store';

/**
 * Generate the drillable opening lines and write them to `opening_line`.
 *
 *   npx tsx scripts/with-env.mts npm run lines:generate --workspace @chessedu/worker
 *   ... -- --dry-run          print the lines, write nothing
 *   ... -- --depth 22         search depth per position (default 20)
 *   ... -- --families 5       how many families from the history (default 3)
 *   ... -- --account jrfx99   whose history (default: the only verified chess account)
 *
 * Which openings is read from the account's games: the families that cost the most points, at
 * least 40 games each, never one the player scores 50% or better in (ADR 0009). In those, the
 * opponent's replies are the ones the player has faced, where there are enough of them, vetted by
 * the engine. The Ponziani is generated as well, by ADR 0007's rule alone: it was the pilot, its
 * lines have review history, and measured replies would retire some of them.
 *
 * A script rather than a worker job, because lines are shared content that changes when the
 * engine, the book or the history does — not per user, not on a trigger (ADR 0006). It reuses
 * the worker's Engine rather than a second UCI client, single-threaded at a fixed depth with the
 * hash cleared before every position, so one binary gives the same lines from the same history.
 *
 * Needs STOCKFISH_PATH and DATABASE_URL. --dry-run still reads the history; it writes nothing.
 */

const DEFAULT_DEPTH = 20;

/** Log the engine's progress every this many positions: three families take several minutes. */
const PROGRESS_EVERY = 10;

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

function positiveInteger(name: string, fallback: number): number {
  const value = Number(flag(name) ?? fallback);
  if (!Number.isInteger(value) || value < 1)
    throw new Error(`--${name} must be a positive integer`);
  return value;
}

function databaseFromEnv(): Database {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set');
  return createDatabase(url, { max: 1 });
}

/** The account whose history chooses the openings: the one named, or the only verified one. */
async function chooseAccount(db: Database): Promise<{ id: string; username: string }> {
  const accounts = await db
    .select({ id: schema.chessAccounts.id, username: schema.chessAccounts.username })
    .from(schema.chessAccounts)
    .where(isNotNull(schema.chessAccounts.verifiedAt));
  const named = flag('account');
  if (named) {
    const account = accounts.find((a) => a.username.toLowerCase() === named.toLowerCase());
    if (!account) throw new Error(`no verified chess account named ${named}`);
    return account;
  }
  if (accounts.length !== 1) {
    throw new Error(
      `${accounts.length} verified chess accounts; name one with --account (${accounts
        .map((a) => a.username)
        .join(', ')})`,
    );
  }
  return accounts[0]!;
}

const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
const side = (color: 'w' | 'b') => (color === 'w' ? 'White' : 'Black');

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run');
  const depth = positiveInteger('depth', DEFAULT_DEPTH);
  const count = positiveInteger('families', DEFAULT_FAMILY_COUNT);

  const binaryPath = process.env.STOCKFISH_PATH;
  if (!binaryPath) throw new Error('STOCKFISH_PATH is not set');

  const db = databaseFromEnv();
  const account = await chooseAccount(db);
  const records = await loadFamilyRecords({ db, chessAccountId: account.id });
  const total = records.reduce((sum, r) => sum + r.games, 0);
  const chosen = chooseOpenings(records, { count });
  const chosenKeys = new Set(chosen.map((c) => `${c.standing.color} ${c.standing.family}`));

  console.log(`[lines] ${account.username}: ${total} games with an opening name`);
  console.log('[lines] families with 40+ games, by points lost (* = generated):');
  for (const s of familyStandings(records)) {
    const mark = chosenKeys.has(`${s.color} ${s.family}`) ? '*' : ' ';
    console.log(
      `  ${mark} ${side(s.color).padEnd(5)} ${familyLabel(s.family).padEnd(48)} ${String(s.games).padStart(4)}  ${pct(s.score).padStart(6)}  ${s.pointsLost.toFixed(1).padStart(6)}`,
    );
  }

  const faced = new Map<'w' | 'b', FacedReplies>();
  for (const color of ['w', 'b'] as const) {
    faced.set(
      color,
      await loadFacedReplies({
        db,
        chessAccountId: account.id,
        color,
        maxPly: lineDepthFor(color),
      }),
    );
  }

  // The Ponziani keeps ADR 0007's engine-margin branching: measured replies would retire lines
  // that carry review history (ADR 0009). The chosen families branch on what was faced.
  const specs: { spec: LineSpec; measured: boolean }[] = [
    { spec: PONZIANI, measured: false },
    ...chosen.map((c) => ({ spec: c.spec, measured: true })),
  ];
  for (const { spec } of specs) {
    console.log(
      `[lines] ${spec.family}: root ${spec.rootSan.join(' ')}, learner ${side(spec.learnerColor)}`,
    );
  }

  const engine = new Engine({ binaryPath, depth, threads: 1, hashMb: 64 });
  await engine.start();

  const book = defaultBook();
  const engineName = `stockfish depth ${depth}`;
  const summary: string[] = [];

  try {
    for (const { spec, measured } of specs) {
      const started = Date.now();
      let asked = 0;
      const lines = await generateLines(spec, {
        book,
        faced: measured ? faced.get(spec.learnerColor) : undefined,
        rankMoves: async (fen, n, only) => {
          asked += 1;
          if (asked % PROGRESS_EVERY === 0) {
            console.log(
              `[lines] ${spec.family}: ${asked} positions, ${Math.round((Date.now() - started) / 1000)}s`,
            );
          }
          // A cleared hash makes the answer a function of the position alone, not of the order
          // positions happened to be asked in.
          await engine.newGame();
          return engine.rankMoves(fen, n, only);
        },
      });

      console.log(
        `[lines] ${spec.family}: ${lines.length} lines, ${asked} engine positions, ${Date.now() - started}ms`,
      );
      for (const line of lines) {
        const moves = line.plies
          .map((p) => (p.color === 'w' ? plyLabel(p.ply, p.san) : p.san))
          .join(' ');
        const sources = line.plies.map((p) => p.source[0]).join('');
        // Each searched ply's lead over the engine's next best, from the mover's side; `.` is none.
        const gaps = line.plies.map((p) => p.facts?.gapCp ?? '.').join(' ');
        console.log(`  ${line.eco} ${line.name}\n    ${moves}   [${sources}]\n    gap cp: ${gaps}`);
      }

      if (dryRun) {
        summary.push(`${spec.family}: ${lines.length} lines (dry run)`);
        continue;
      }
      const result = await saveGeneratedLines({
        db,
        family: spec.family,
        lines,
        engine: engineName,
      });
      console.log(`[lines] ${spec.family}: saved ${result.saved}, retired ${result.retired}`);
      summary.push(`${spec.family}: ${result.saved} lines, ${result.retired} retired`);
    }
  } finally {
    await engine.stop();
  }

  console.log(`[lines] done\n  ${summary.join('\n  ')}`);
}

main().then(
  () => process.exit(0),
  (error: unknown) => {
    console.error('[lines] failed:', error);
    process.exit(1);
  },
);
