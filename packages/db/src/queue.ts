import { and, eq, lte, sql } from 'drizzle-orm';

import type { Database } from './client';
import { jobs } from './schema';
import type { Job } from './schema';

/**
 * A job queue on top of Postgres. `FOR UPDATE SKIP LOCKED` lets several workers claim
 * disjoint rows without coordination, which is all this project needs — see ADR 0001.
 */

export type JobKind = 'ingest' | 'analyze' | 'embed' | 'puzzle_gen';

export const BASE_RETRY_MS = 30_000;
export const MAX_RETRY_MS = 30 * 60 * 1000;

/**
 * Exponential backoff, capped. Pure so the schedule is testable without a database.
 * `attempts` is the number of attempts already made.
 */
export function nextRetryDelayMs(attempts: number): number {
  const exponent = Math.max(0, attempts - 1);
  return Math.min(MAX_RETRY_MS, BASE_RETRY_MS * 2 ** exponent);
}

export interface EnqueueOptions {
  kind: JobKind;
  payload: unknown;
  priority?: number;
  /** Makes enqueueing idempotent — a second enqueue with the same key is a no-op. */
  dedupeKey?: string;
  runAfter?: Date;
  maxAttempts?: number;
}

export async function enqueue(database: Database, options: EnqueueOptions): Promise<void> {
  await database
    .insert(jobs)
    .values({
      kind: options.kind,
      payload: options.payload as never,
      priority: options.priority ?? 0,
      dedupeKey: options.dedupeKey ?? null,
      runAfter: options.runAfter ?? new Date(),
      maxAttempts: options.maxAttempts ?? 3,
    })
    .onConflictDoNothing({ target: jobs.dedupeKey });
}

/**
 * Claim the highest-priority due job, skipping any row another worker holds. Returns null
 * when there is nothing to do.
 */
export async function claimJob(
  database: Database,
  workerId: string,
  kinds?: readonly JobKind[],
): Promise<Job | null> {
  const kindFilter = kinds?.length
    ? sql`and kind in ${sql.raw(`(${kinds.map((k) => `'${k}'`).join(',')})`)}`
    : sql``;

  const claimed = await database.execute<Job>(sql`
    update "job"
    set state = 'running',
        attempts = attempts + 1,
        locked_at = now(),
        locked_by = ${workerId},
        updated_at = now()
    where id = (
      select id from "job"
      where state = 'pending' and run_after <= now() ${kindFilter}
      order by priority desc, run_after asc
      for update skip locked
      limit 1
    )
    returning *
  `);

  return (claimed as unknown as Job[])[0] ?? null;
}

export async function completeJob(database: Database, jobId: string): Promise<void> {
  await database
    .update(jobs)
    .set({ state: 'done', lockedAt: null, lockedBy: null, updatedAt: new Date() })
    .where(eq(jobs.id, jobId));
}

/**
 * Record a failure. The job goes back to `pending` with a backoff until `maxAttempts` is
 * spent, after which it is parked in `failed` for a human to look at.
 */
export async function failJob(database: Database, job: Job, error: unknown): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  const exhausted = job.attempts >= job.maxAttempts;

  await database
    .update(jobs)
    .set({
      state: exhausted ? 'failed' : 'pending',
      runAfter: new Date(Date.now() + nextRetryDelayMs(job.attempts)),
      lastError: message.slice(0, 2000),
      lockedAt: null,
      lockedBy: null,
      updatedAt: new Date(),
    })
    .where(eq(jobs.id, job.id));
}

/**
 * Return jobs whose worker died mid-run to the queue. Called on worker start and periodically:
 * a `running` row with an old lock has no live owner.
 */
export async function reclaimStalledJobs(
  database: Database,
  staleAfterMs = 15 * 60 * 1000,
): Promise<number> {
  const cutoff = new Date(Date.now() - staleAfterMs);
  const result = await database
    .update(jobs)
    .set({ state: 'pending', lockedAt: null, lockedBy: null, updatedAt: new Date() })
    .where(and(eq(jobs.state, 'running'), lte(jobs.lockedAt, cutoff)))
    .returning({ id: jobs.id });
  return result.length;
}
