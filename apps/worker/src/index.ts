import { ChessComClient } from '@chessedu/chesscom';
import {
  type Job,
  claimJob,
  completeJob,
  createDatabase,
  failJob,
  reclaimStalledJobs,
} from '@chessedu/db';

import { loadConfig } from './config';
import { Engine } from './engine';
import { type AnalyzePayload, runAnalyze } from './handlers/analyze';
import { type IngestPayload, runIngest } from './handlers/ingest';

/**
 * The worker: claim a job, run it, repeat.
 *
 * It exposes no inbound port. Nothing can call it — it only ever polls Postgres, which is why
 * it needs no authentication of its own. See docs/architecture.md, section 13.
 */

const config = loadConfig();
const db = createDatabase(config.databaseUrl, { max: 4 });
const client = new ChessComClient({ contact: config.chesscomContact });
const engine = new Engine({
  binaryPath: config.stockfishPath,
  depth: config.stockfishDepth,
  threads: config.stockfishThreads,
  hashMb: config.stockfishHashMb,
});

let running = true;

async function handle(job: Job): Promise<void> {
  switch (job.kind) {
    case 'ingest':
      await runIngest({ db, client }, job.payload as IngestPayload);
      return;
    case 'analyze':
      await runAnalyze(
        {
          db,
          engine,
          depth: config.stockfishDepth,
          engineName: `stockfish depth ${config.stockfishDepth}`,
        },
        job.payload as AnalyzePayload,
      );
      return;
    default:
      // Kinds the schema allows but this worker has no handler for yet.
      throw new Error(`unhandled job kind: ${job.kind}`);
  }
}

async function main(): Promise<void> {
  await engine.start();
  console.log(`[worker] ${config.workerId} started`);

  // Anything a previous machine died holding is nobody's now.
  const reclaimed = await reclaimStalledJobs(db);
  if (reclaimed > 0) console.log(`[worker] reclaimed ${reclaimed} stalled jobs`);

  while (running) {
    const job = await claimJob(db, config.workerId, ['ingest', 'analyze']);
    if (!job) {
      await sleep(config.idlePollMs);
      continue;
    }

    const startedAt = Date.now();
    try {
      await handle(job);
      await completeJob(db, job.id);
      console.log(`[worker] ${job.kind} ${job.id} done in ${Date.now() - startedAt}ms`);
    } catch (error) {
      await failJob(db, job, error);
      console.error(`[worker] ${job.kind} ${job.id} failed:`, error);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Stop taking new work, but let the job in flight finish. Fly sends SIGTERM before replacing a
 * machine; a half-analysed game would otherwise be reclaimed and redone.
 */
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    console.log(`[worker] ${signal} received, finishing current job`);
    running = false;
    void engine.stop();
  });
}

main().catch((error) => {
  console.error('[worker] fatal:', error);
  process.exitCode = 1;
});
