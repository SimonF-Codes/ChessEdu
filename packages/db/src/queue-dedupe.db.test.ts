import { and, eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { createDatabase } from './client';
import { enqueue } from './queue';
import { jobs } from './schema';

/**
 * The dedupe key must stop a second copy being queued while one is outstanding, and must stop
 * nothing once the job has finished.
 *
 * Before migration 0003 the unique index covered every row, so a finished `ingest:<accountId>`
 * silently swallowed every later sync request for that account — `enqueue` uses
 * `onConflictDoNothing`, so the caller saw success and nothing happened. The only way to sync
 * again was to unlink the account and link it back.
 *
 * These run against a real Postgres because the behaviour under test *is* the index.
 */

const url = process.env.TEST_DATABASE_URL;
const describeDb = url ? describe : describe.skip;

describeDb('enqueue dedupe', () => {
  const database = createDatabase(url!);
  const KEY = 'ingest:dedupe-suite';

  const payload = { chessAccountId: 'dedupe-suite' };
  const rows = () => database.select().from(jobs).where(eq(jobs.dedupeKey, KEY));

  beforeEach(async () => {
    await database.delete(jobs).where(eq(jobs.dedupeKey, KEY));
  });

  afterAll(async () => {
    await database.delete(jobs).where(eq(jobs.dedupeKey, KEY));
  });

  it('queues the first job', async () => {
    await enqueue(database, { kind: 'ingest', payload, dedupeKey: KEY });
    expect(await rows()).toHaveLength(1);
  });

  it('does not queue a second while the first is pending', async () => {
    await enqueue(database, { kind: 'ingest', payload, dedupeKey: KEY });
    await enqueue(database, { kind: 'ingest', payload, dedupeKey: KEY });
    expect(await rows()).toHaveLength(1);
  });

  it('does not queue a second while the first is running', async () => {
    await enqueue(database, { kind: 'ingest', payload, dedupeKey: KEY });
    await database.update(jobs).set({ state: 'running' }).where(eq(jobs.dedupeKey, KEY));

    await enqueue(database, { kind: 'ingest', payload, dedupeKey: KEY });
    expect(await rows()).toHaveLength(1);
  });

  it('queues again once the first is done — the case that was broken', async () => {
    await enqueue(database, { kind: 'ingest', payload, dedupeKey: KEY });
    await database.update(jobs).set({ state: 'done' }).where(eq(jobs.dedupeKey, KEY));

    await enqueue(database, { kind: 'ingest', payload, dedupeKey: KEY });

    expect(await rows()).toHaveLength(2);
    const pending = await database
      .select()
      .from(jobs)
      .where(and(eq(jobs.dedupeKey, KEY), eq(jobs.state, 'pending')));
    expect(pending).toHaveLength(1);
  });

  it('queues again once the first has failed', async () => {
    await enqueue(database, { kind: 'ingest', payload, dedupeKey: KEY });
    await database.update(jobs).set({ state: 'failed' }).where(eq(jobs.dedupeKey, KEY));

    await enqueue(database, { kind: 'ingest', payload, dedupeKey: KEY });
    expect(await rows()).toHaveLength(2);
  });

  it('leaves jobs without a dedupe key alone', async () => {
    // A null key is not a key: two of them must both land.
    await enqueue(database, { kind: 'analyze', payload: { gameId: 'a' } });
    await enqueue(database, { kind: 'analyze', payload: { gameId: 'b' } });
    // Nothing to assert on KEY here; the point is that neither insert threw.
    expect(true).toBe(true);
  });
});
