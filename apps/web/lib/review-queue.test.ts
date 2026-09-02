import { and, eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { LAPSE_INTERVAL_DAYS, MIN_EASE } from '@chessedu/chess';
import { createDatabase, schema } from '@chessedu/db';

import { countDuePuzzles, gradePuzzleReview, loadReviewSession } from './review-queue';

/**
 * Exercised against real Postgres, never a mock — the point of these tests is the `user_id`
 * scoping and the due-date predicate, which a stubbed query object would happily agree with. CI
 * provides the database; locally this suite is skipped unless TEST_DATABASE_URL is set. See
 * CONTRIBUTING.md.
 */
const connectionString = process.env.TEST_DATABASE_URL;

const DAY_MS = 24 * 60 * 60 * 1000;

describe.skipIf(!connectionString)('review queue', () => {
  const db = createDatabase(connectionString!, { max: 4 });

  const NOW = new Date('2026-08-27T12:00:00.000Z');
  const FEN = 'r1bqkbnr/pppp1ppp/2n5/4p3/2B1P3/5Q2/PPPP1PPP/RNB1K1NR w KQkq - 4 4';

  async function makeUser(email: string): Promise<string> {
    const [row] = await db
      .insert(schema.users)
      .values({ email, name: 'Test' })
      .returning({ id: schema.users.id });
    return row!.id;
  }

  async function makePuzzle(
    userId: string,
    overrides: Partial<typeof schema.puzzles.$inferInsert> = {},
  ): Promise<string> {
    const [row] = await db
      .insert(schema.puzzles)
      .values({
        userId,
        fen: FEN,
        solutionUci: ['f3f7'],
        themes: ['middlegame'],
        dueAt: new Date(NOW.getTime() - DAY_MS),
        ...overrides,
      })
      .returning({ id: schema.puzzles.id });
    return row!.id;
  }

  let userId: string;
  let otherUserId: string;

  beforeEach(async () => {
    await db.delete(schema.puzzles);
    await db.delete(schema.users);
    userId = await makeUser(`review-${Date.now()}@example.com`);
    otherUserId = await makeUser(`other-${Date.now()}@example.com`);
  });

  afterAll(async () => {
    await db.delete(schema.users);
  });

  describe('loadReviewSession', () => {
    it('returns only puzzles belonging to the asking user', async () => {
      const mine = await makePuzzle(userId);
      await makePuzzle(otherUserId);

      const session = await loadReviewSession({ db, userId, now: NOW });

      expect(session.map((p) => p.id)).toEqual([mine]);
    });

    it('leaves puzzles that are not due yet alone', async () => {
      const due = await makePuzzle(userId);
      await makePuzzle(userId, { dueAt: new Date(NOW.getTime() + 7 * DAY_MS) });

      const session = await loadReviewSession({ db, userId, now: NOW });

      expect(session.map((p) => p.id)).toEqual([due]);
    });

    it('carries the fields the board needs to render the position', async () => {
      await makePuzzle(userId, { playedUci: 'e1g1', phase: 'middlegame' });

      const [puzzle] = await loadReviewSession({ db, userId, now: NOW });

      expect(puzzle).toMatchObject({
        fen: FEN,
        solutionUci: ['f3f7'],
        playedUci: 'e1g1',
        themes: ['middlegame'],
      });
    });

    it('applies the ordering policy: the weakest theme leads the session', async () => {
      for (let i = 0; i < 3; i += 1) {
        await makePuzzle(userId, { themes: ['opening'], repetitions: 5, lapses: 0 });
        await makePuzzle(userId, { themes: ['endgame'], repetitions: 0, lapses: 5 });
      }

      const session = await loadReviewSession({ db, userId, now: NOW, sessionSize: 6 });

      expect(session[0]?.themes).toEqual(['endgame']);
    });

    it('honours the session size', async () => {
      for (let i = 0; i < 12; i += 1) await makePuzzle(userId);
      const session = await loadReviewSession({ db, userId, now: NOW, sessionSize: 5 });
      expect(session).toHaveLength(5);
    });
  });

  describe('countDuePuzzles', () => {
    it('counts the backlog, not just the session', async () => {
      for (let i = 0; i < 12; i += 1) await makePuzzle(userId);
      await makePuzzle(userId, { dueAt: new Date(NOW.getTime() + DAY_MS) });
      await makePuzzle(otherUserId);

      expect(await countDuePuzzles({ db, userId, now: NOW })).toBe(12);
    });
  });

  describe('gradePuzzleReview', () => {
    it('writes the SM-2 state back and pushes the due date out on a pass', async () => {
      const id = await makePuzzle(userId);

      const scheduled = await gradePuzzleReview({
        db,
        userId,
        puzzleId: id,
        outcome: 'good',
        now: NOW,
      });

      expect(scheduled).toMatchObject({ repetitions: 1, lapses: 0, intervalDays: 1 });

      const stored = await db.query.puzzles.findFirst({ where: eq(schema.puzzles.id, id) });
      expect(stored!.repetitions).toBe(1);
      expect(stored!.dueAt.getTime()).toBe(NOW.getTime() + DAY_MS);
    });

    it('records a lapse and brings the puzzle straight back', async () => {
      const id = await makePuzzle(userId, { intervalDays: 120, repetitions: 6, ease: 2.2 });

      const scheduled = await gradePuzzleReview({
        db,
        userId,
        puzzleId: id,
        outcome: 'again',
        now: NOW,
      });

      expect(scheduled).toMatchObject({
        repetitions: 0,
        lapses: 1,
        intervalDays: LAPSE_INTERVAL_DAYS,
      });
      expect(scheduled!.ease).toBeGreaterThanOrEqual(MIN_EASE);
      expect(scheduled!.ease).toBeLessThan(2.2);

      const stored = await db.query.puzzles.findFirst({ where: eq(schema.puzzles.id, id) });
      expect(stored!.lapses).toBe(1);
      expect(stored!.dueAt.getTime()).toBe(NOW.getTime() + LAPSE_INTERVAL_DAYS * DAY_MS);
    });

    it('will not grade another user’s puzzle, whatever id the client sends', async () => {
      const theirs = await makePuzzle(otherUserId);

      const scheduled = await gradePuzzleReview({
        db,
        userId,
        puzzleId: theirs,
        outcome: 'again',
        now: NOW,
      });

      expect(scheduled).toBeNull();
      const untouched = await db.query.puzzles.findFirst({
        where: and(eq(schema.puzzles.id, theirs), eq(schema.puzzles.userId, otherUserId)),
      });
      expect(untouched!.lapses).toBe(0);
      expect(untouched!.repetitions).toBe(0);
    });

    it('returns null for a puzzle id that does not exist', async () => {
      const scheduled = await gradePuzzleReview({
        db,
        userId,
        puzzleId: '00000000-0000-0000-0000-000000000000',
        outcome: 'good',
        now: NOW,
      });
      expect(scheduled).toBeNull();
    });
  });
});
