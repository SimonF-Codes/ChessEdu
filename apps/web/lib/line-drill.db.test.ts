import { Chess } from 'chess.js';
import { and, eq, like } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { type PlyAttempt, type PlyResult, LAPSE_INTERVAL_DAYS } from '@chessedu/chess';
import { type OpeningLinePly, createDatabase, schema } from '@chessedu/db';

import { loadLineHistory, loadLineQueue, recordLineAttempt } from './line-drill';

/**
 * Against real Postgres, as CONTRIBUTING.md requires: what is under test is the `user_id`
 * scoping, the due-date predicate, and that an attempt lands as one row per ply — none of which a
 * mocked query would disagree with. Skipped without TEST_DATABASE_URL.
 *
 * `opening_line` is a shared catalogue that a real generator run may have filled on the same
 * database, so this suite only ever touches its own family and never truncates the table.
 */
const connectionString = process.env.TEST_DATABASE_URL;

const DAY_MS = 24 * 60 * 60 * 1000;
const FAMILY = 'test-line-drill';

function pliesOf(sans: string[]): OpeningLinePly[] {
  const board = new Chess();
  return sans.map((san, index) => {
    const fenBefore = board.fen();
    const move = board.move(san);
    return {
      ply: index + 1,
      color: move.color,
      san: move.san,
      uci: `${move.from}${move.to}${move.promotion ?? ''}`,
      fenBefore,
      source: index < 5 ? 'opening' : index % 2 === 0 ? 'engine' : 'book',
    };
  });
}

const PONZIANI_D5 = ['e4', 'e5', 'Nf3', 'Nc6', 'c3', 'd5', 'Qa4'];
const PONZIANI_NF6 = ['e4', 'e5', 'Nf3', 'Nc6', 'c3', 'Nf6', 'd4'];
const LEARNER_PLIES = [1, 3, 5, 7];

function attempt(results: PlyResult[], elapsedMs = 2_000): PlyAttempt[] {
  return results.map((result, index) => ({
    ply: LEARNER_PLIES[index]!,
    result,
    elapsedMs,
    wrongUci: result === 'first_try' ? [] : ['a2a3'],
  }));
}

const CLEAN: PlyResult[] = ['first_try', 'first_try', 'first_try', 'first_try'];

describe.skipIf(!connectionString)('line drill', () => {
  const db = createDatabase(connectionString!, { max: 4 });
  const NOW = new Date('2026-09-28T12:00:00.000Z');

  async function makeUser(email: string): Promise<string> {
    const [row] = await db
      .insert(schema.users)
      .values({ email, name: 'Test' })
      .returning({ id: schema.users.id });
    return row!.id;
  }

  async function makeLine(
    sans: string[],
    overrides: Partial<typeof schema.openingLines.$inferInsert> = {},
  ): Promise<string> {
    const plies = pliesOf(sans);
    const [row] = await db
      .insert(schema.openingLines)
      .values({
        key: `test:${sans.join(' ')}:${Math.random()}`,
        family: FAMILY,
        eco: 'C44',
        name: 'Ponziani Opening',
        learnerColor: 'w',
        plies,
        plyCount: plies.length,
        engine: 'test',
        ...overrides,
      })
      .returning({ id: schema.openingLines.id });
    return row!.id;
  }

  async function cleanUp(): Promise<void> {
    await db.delete(schema.lineAttempts);
    await db.delete(schema.lineReviews);
    await db.delete(schema.openingLines).where(like(schema.openingLines.family, 'test-%'));
    await db.delete(schema.users);
  }

  let userId: string;
  let otherUserId: string;
  let lineId: string;

  beforeEach(async () => {
    await cleanUp();
    userId = await makeUser(`lines-${Date.now()}@example.com`);
    otherUserId = await makeUser(`other-${Date.now()}@example.com`);
    lineId = await makeLine(PONZIANI_D5);
  });

  afterAll(async () => {
    await cleanUp();
  });

  describe('recordLineAttempt', () => {
    it('writes one line_attempt row per learner move, with what happened on each', async () => {
      const recorded = await recordLineAttempt({
        db,
        userId,
        lineId,
        plies: attempt(['first_try', 'second_try', 'first_try', 'revealed']),
        now: NOW,
      });
      expect(recorded).not.toBeNull();

      const rows = await db
        .select()
        .from(schema.lineAttempts)
        .where(eq(schema.lineAttempts.userId, userId))
        .orderBy(schema.lineAttempts.ply);

      expect(rows.map((r) => [r.ply, r.result])).toEqual([
        [1, 'first_try'],
        [3, 'second_try'],
        [5, 'first_try'],
        [7, 'revealed'],
      ]);
      expect(new Set(rows.map((r) => r.attemptId))).toEqual(new Set([recorded!.attemptId]));
      expect(rows[1]!.wrongUci).toEqual(['a2a3']);
      expect(rows[0]!.elapsedMs).toBe(2_000);
      expect(rows.every((r) => r.attemptedAt.getTime() === NOW.getTime())).toBe(true);
    });

    it('creates the review on the first attempt and schedules it from the derived outcome', async () => {
      const recorded = await recordLineAttempt({
        db,
        userId,
        lineId,
        plies: attempt(CLEAN),
        now: NOW,
      });

      expect(recorded!.outcome).toBe('easy');
      const review = await db.query.lineReviews.findFirst({
        where: and(eq(schema.lineReviews.userId, userId), eq(schema.lineReviews.lineId, lineId)),
      });
      expect(review).toMatchObject({ repetitions: 1, lapses: 0, intervalDays: 1 });
      expect(review!.ease).toBeGreaterThan(2.5);
      expect(review!.dueAt.getTime()).toBe(NOW.getTime() + DAY_MS);
    });

    it('advances an existing review, and a reveal lapses it straight back', async () => {
      await recordLineAttempt({ db, userId, lineId, plies: attempt(CLEAN, 20_000), now: NOW });
      const later = new Date(NOW.getTime() + DAY_MS);
      await recordLineAttempt({ db, userId, lineId, plies: attempt(CLEAN, 20_000), now: later });

      let review = await db.query.lineReviews.findFirst({
        where: eq(schema.lineReviews.lineId, lineId),
      });
      expect(review).toMatchObject({ repetitions: 2, intervalDays: 6, lapses: 0 });

      const lapse = new Date(later.getTime() + 6 * DAY_MS);
      const recorded = await recordLineAttempt({
        db,
        userId,
        lineId,
        plies: attempt(['first_try', 'first_try', 'first_try', 'revealed']),
        now: lapse,
      });
      expect(recorded!.outcome).toBe('again');

      review = await db.query.lineReviews.findFirst({
        where: eq(schema.lineReviews.lineId, lineId),
      });
      expect(review).toMatchObject({
        repetitions: 0,
        lapses: 1,
        intervalDays: LAPSE_INTERVAL_DAYS,
      });
      expect(review!.dueAt.getTime()).toBe(lapse.getTime() + LAPSE_INTERVAL_DAYS * DAY_MS);
    });

    it('grades an abandoned line as a lapse and records the untried moves as abandoned', async () => {
      const recorded = await recordLineAttempt({
        db,
        userId,
        lineId,
        plies: attempt(['first_try', 'abandoned', 'abandoned', 'abandoned'], 0),
        now: NOW,
      });
      expect(recorded!.outcome).toBe('again');
      const rows = await db
        .select({ result: schema.lineAttempts.result })
        .from(schema.lineAttempts)
        .where(eq(schema.lineAttempts.attemptId, recorded!.attemptId));
      expect(rows.filter((r) => r.result === 'abandoned')).toHaveLength(3);
    });

    it('records nothing for an attempt that does not match the line', async () => {
      const recorded = await recordLineAttempt({
        db,
        userId,
        lineId,
        plies: attempt(CLEAN).slice(0, 3),
        now: NOW,
      });
      expect(recorded).toBeNull();
      expect(await db.select().from(schema.lineAttempts)).toHaveLength(0);
      expect(await db.select().from(schema.lineReviews)).toHaveLength(0);
    });

    it('records nothing for a line id that does not exist', async () => {
      const recorded = await recordLineAttempt({
        db,
        userId,
        lineId: '00000000-0000-0000-0000-000000000000',
        plies: attempt(CLEAN),
        now: NOW,
      });
      expect(recorded).toBeNull();
    });

    it('leaves another user’s schedule for the same line alone', async () => {
      await recordLineAttempt({ db, userId: otherUserId, lineId, plies: attempt(CLEAN), now: NOW });
      await recordLineAttempt({
        db,
        userId,
        lineId,
        plies: attempt(['revealed', 'revealed', 'revealed', 'revealed']),
        now: NOW,
      });

      const theirs = await db.query.lineReviews.findFirst({
        where: and(
          eq(schema.lineReviews.userId, otherUserId),
          eq(schema.lineReviews.lineId, lineId),
        ),
      });
      expect(theirs).toMatchObject({ repetitions: 1, lapses: 0 });
    });
  });

  describe('loadLineHistory', () => {
    it('returns this user’s attempts at this line, newest first, plies in order', async () => {
      await recordLineAttempt({ db, userId, lineId, plies: attempt(CLEAN), now: NOW });
      const later = new Date(NOW.getTime() + DAY_MS);
      await recordLineAttempt({
        db,
        userId,
        lineId,
        plies: attempt(['first_try', 'first_try', 'first_try', 'revealed']),
        now: later,
      });
      await recordLineAttempt({
        db,
        userId: otherUserId,
        lineId,
        plies: attempt(CLEAN),
        now: later,
      });

      const history = await loadLineHistory({ db, userId, lineId });

      expect(history).toHaveLength(2);
      expect(history[0]!.attemptedAt.getTime()).toBe(later.getTime());
      expect(history[0]!.plies.map((p) => p.ply)).toEqual(LEARNER_PLIES);
      expect(history[0]!.plies.at(-1)!.result).toBe('revealed');
      expect(history[1]!.plies.every((p) => p.result === 'first_try')).toBe(true);
    });
  });

  describe('loadLineQueue', () => {
    it('offers a never-tried line when nothing is due', async () => {
      const queue = await loadLineQueue({ db, userId, family: FAMILY, now: NOW });
      expect(queue.next?.id).toBe(lineId);
      expect(queue.unseen).toBe(1);
      expect(queue.due).toBe(0);
    });

    it('prefers a due line over a new one', async () => {
      const second = await makeLine(PONZIANI_NF6);
      await recordLineAttempt({
        db,
        userId,
        lineId: second,
        plies: attempt(['revealed', 'first_try', 'first_try', 'first_try']),
        now: new Date(NOW.getTime() - 3 * DAY_MS),
      });

      const queue = await loadLineQueue({ db, userId, family: FAMILY, now: NOW });
      expect(queue.next?.id).toBe(second);
      expect(queue.due).toBe(1);
      expect(queue.unseen).toBe(1);
    });

    it('returns nothing, and when the next line comes due, once every line is scheduled ahead', async () => {
      await recordLineAttempt({ db, userId, lineId, plies: attempt(CLEAN), now: NOW });

      const queue = await loadLineQueue({ db, userId, family: FAMILY, now: NOW });
      expect(queue.next).toBeNull();
      expect(queue.nextDueAt?.getTime()).toBe(NOW.getTime() + DAY_MS);
    });

    it('is scoped to the asking user — another user’s review does not hide a line', async () => {
      await recordLineAttempt({ db, userId: otherUserId, lineId, plies: attempt(CLEAN), now: NOW });
      const queue = await loadLineQueue({ db, userId, family: FAMILY, now: NOW });
      expect(queue.next?.id).toBe(lineId);
    });

    it('never offers a retired line', async () => {
      await db
        .update(schema.openingLines)
        .set({ retiredAt: NOW })
        .where(eq(schema.openingLines.id, lineId));
      const queue = await loadLineQueue({ db, userId, family: FAMILY, now: NOW });
      expect(queue.next).toBeNull();
      expect(queue.total).toBe(0);
    });

    it('carries the plies the board needs', async () => {
      const queue = await loadLineQueue({ db, userId, family: FAMILY, now: NOW });
      expect(queue.next!.plies.map((p) => p.san)).toEqual(PONZIANI_D5);
      expect(queue.next!.learnerColor).toBe('w');
    });
  });
});
