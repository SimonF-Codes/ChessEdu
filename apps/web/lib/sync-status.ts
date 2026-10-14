import { and, desc, eq, inArray, sql } from 'drizzle-orm';

import { type Database, schema } from '@chessedu/db';

/**
 * What the history sync is actually doing, read from the job table.
 *
 * This exists because the dashboard used to print "Sync queued." whenever it had no games to
 * show, without ever looking at a job. That sentence was true the first time anyone saw it and
 * a lie every time after: a sync that had failed, or had never been requested at all, said
 * exactly the same thing as one in progress, forever. The only honest states are the ones the
 * queue can tell us about.
 */
export type SyncStatus =
  /** No ingest job has ever been queued for this account. */
  | { state: 'never' }
  /** Queued, not yet picked up. */
  | { state: 'queued'; since: Date }
  /** A worker is holding it. */
  | { state: 'running'; since: Date }
  /** Gave up after `maxAttempts`. `error` is whatever the handler last threw. */
  | { state: 'failed'; since: Date; attempts: number; error: string | null }
  /** Finished. `games` is what the account actually has now. */
  | { state: 'done'; since: Date; games: number };

/**
 * The newest ingest job for an account, plus its game count.
 *
 * Keyed on the dedupe key rather than scanning the payload: `ingest:<accountId>` is the shape
 * link-account.ts writes, and it is indexed.
 */
export async function loadSyncStatus(
  database: Database,
  chessAccountId: string,
): Promise<SyncStatus> {
  const job = await database.query.jobs.findFirst({
    where: and(
      eq(schema.jobs.kind, 'ingest'),
      eq(schema.jobs.dedupeKey, `ingest:${chessAccountId}`),
    ),
    orderBy: desc(schema.jobs.createdAt),
  });

  if (!job) return { state: 'never' };

  const since = job.updatedAt ?? job.createdAt;

  switch (job.state) {
    case 'pending':
      return { state: 'queued', since };
    case 'running':
      return { state: 'running', since };
    case 'failed':
      return { state: 'failed', since, attempts: job.attempts, error: job.lastError };
    case 'done': {
      const [row] = await database
        .select({ n: sql<number>`count(*)::int` })
        .from(schema.games)
        .where(eq(schema.games.chessAccountId, chessAccountId));
      return { state: 'done', since, games: row?.n ?? 0 };
    }
  }
}

/** How much of the analysis backlog is left, for a progress line under the sync state. */
export async function loadAnalysisBacklog(database: Database): Promise<number> {
  const [row] = await database
    .select({ n: sql<number>`count(*)::int` })
    .from(schema.jobs)
    .where(
      and(eq(schema.jobs.kind, 'analyze'), inArray(schema.jobs.state, ['pending', 'running'])),
    );
  return row?.n ?? 0;
}

/** One sentence a person can act on, for each state. */
export function describeSyncStatus(status: SyncStatus, username: string): string {
  switch (status.state) {
    case 'never':
      return `No sync has been run for ${username} yet.`;
    case 'queued':
      return 'Sync queued, waiting for a worker to pick it up.';
    case 'running':
      return 'Sync running. Games appear as they are pulled in, and the engine starts on each one as it lands.';
    case 'failed':
      return `Sync failed after ${status.attempts} ${status.attempts === 1 ? 'attempt' : 'attempts'}.`;
    case 'done':
      return status.games === 0
        ? 'Sync finished but found no games on this account.'
        : `Sync finished. ${status.games.toLocaleString()} games on file.`;
  }
}

/**
 * Whether a worker looks absent.
 *
 * A job sitting in `pending` for a long time almost always means nothing is draining the queue
 * — the usual cause in development, where the worker is a separate process somebody has to
 * start. Worth saying out loud rather than leaving the page to look merely slow.
 */
export const STALE_QUEUE_MS = 5 * 60 * 1000;

export function looksUnattended(status: SyncStatus, now = Date.now()): boolean {
  return status.state === 'queued' && now - status.since.getTime() > STALE_QUEUE_MS;
}
