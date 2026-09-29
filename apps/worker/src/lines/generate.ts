import { type LineSpec, PONZIANI, defaultBook, generateLines, plyLabel } from '@chessedu/chess';
import { type Database, createDatabase } from '@chessedu/db';

import { Engine } from '../engine';
import { saveGeneratedLines } from './store';

/**
 * Generate the drillable opening lines and write them to `opening_line`.
 *
 *   npx tsx scripts/with-env.mts npm run lines:generate --workspace @chessedu/worker
 *   ... -- --dry-run          print the lines, write nothing
 *   ... -- --depth 22         search depth per position (default 20)
 *
 * A script rather than a worker job, because lines are shared content that changes when the
 * engine or the book does — not per user, not on a trigger (ADR 0006). It reuses the worker's
 * Engine rather than a second UCI client, single-threaded at a fixed depth with the hash cleared
 * before every position, so one binary gives the same lines on every run.
 *
 * Needs STOCKFISH_PATH, and DATABASE_URL unless --dry-run.
 */

const SPECS: readonly LineSpec[] = [PONZIANI];

const DEFAULT_DEPTH = 20;

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

let database: Database | undefined;

function databaseFromEnv(): Database {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set');
  database ??= createDatabase(url, { max: 1 });
  return database;
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run');
  const depth = Number(flag('depth') ?? DEFAULT_DEPTH);
  if (!Number.isInteger(depth) || depth < 1) throw new Error('--depth must be a positive integer');

  const binaryPath = process.env.STOCKFISH_PATH;
  if (!binaryPath) throw new Error('STOCKFISH_PATH is not set');

  const engine = new Engine({ binaryPath, depth, threads: 1, hashMb: 64 });
  await engine.start();

  const book = defaultBook();
  const engineName = `stockfish depth ${depth}`;

  try {
    for (const spec of SPECS) {
      const started = Date.now();
      let asked = 0;
      const lines = await generateLines(spec, {
        book,
        rankMoves: async (fen, count) => {
          asked += 1;
          // A cleared hash makes the answer a function of the position alone, not of the order
          // positions happened to be asked in.
          await engine.newGame();
          return engine.rankMoves(fen, count);
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

      if (dryRun) continue;
      const result = await saveGeneratedLines({
        db: databaseFromEnv(),
        family: spec.family,
        lines,
        engine: engineName,
      });
      console.log(`[lines] ${spec.family}: saved ${result.saved}, retired ${result.retired}`);
    }
  } finally {
    await engine.stop();
  }
}

main().then(
  () => process.exit(0),
  (error: unknown) => {
    console.error('[lines] failed:', error);
    process.exit(1);
  },
);
