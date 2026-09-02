import { and, asc, count, eq, lte } from 'drizzle-orm';

import {
  type Phase,
  type ReviewOutcome,
  type ScheduledReview,
  DEFAULT_SESSION_SIZE,
  reviewPuzzle,
  selectReviewSession,
} from '@chessedu/chess';
import { type Database, schema } from '@chessedu/db';

/**
 * Reading the review queue and writing back what a review taught us.
 *
 * Plain functions taking a database, so they can be tested without Next.js in the way — the
 * server actions in app/(app)/review/actions.ts are thin wrappers that add the session. Every
 * query here is scoped by `userId`, and that id always comes from the session cookie, never from
 * the client (see the security posture in docs/architecture.md).
 *
 * The *policy* — which due puzzles a session shows, and in what order — is not here. It is pure,
 * lives in `packages/chess/src/review.ts`, and is explained in ADR 0002. This module's only job
 * is to hand it a candidate pool.
 */

/**
 * How many due puzzles are read before the policy ranks them. Ranking needs theme aggregates
 * over the whole pool, so it happens in memory rather than in SQL; this bounds that work. The
 * pool is read in `due_at` order, which `puzzle_due_idx` serves directly.
 */
export const REVIEW_POOL_SIZE = 200;

/** A puzzle as the review session needs it: enough to play it and enough to reschedule it. */
export interface ReviewPuzzle {
  id: string;
  gameId: string | null;
  ply: number | null;
  fen: string;
  solutionUci: string[];
  playedUci: string | null;
  themes: string[];
  phase: Phase | null;
  dueAt: Date;
  intervalDays: number;
  ease: number;
  repetitions: number;
  lapses: number;
}

const COLUMNS = {
  id: schema.puzzles.id,
  gameId: schema.puzzles.gameId,
  ply: schema.puzzles.ply,
  fen: schema.puzzles.fen,
  solutionUci: schema.puzzles.solutionUci,
  playedUci: schema.puzzles.playedUci,
  themes: schema.puzzles.themes,
  phase: schema.puzzles.phase,
  dueAt: schema.puzzles.dueAt,
  intervalDays: schema.puzzles.intervalDays,
  ease: schema.puzzles.ease,
  repetitions: schema.puzzles.repetitions,
  lapses: schema.puzzles.lapses,
} as const;

/** Puzzles due for this user, ordered by the policy in `packages/chess`. */
export async function loadReviewSession(input: {
  db: Database;
  userId: string;
  now?: Date;
  sessionSize?: number;
}): Promise<ReviewPuzzle[]> {
  const now = input.now ?? new Date();

  const pool = await input.db
    .select(COLUMNS)
    .from(schema.puzzles)
    .where(and(eq(schema.puzzles.userId, input.userId), lte(schema.puzzles.dueAt, now)))
    .orderBy(asc(schema.puzzles.dueAt))
    .limit(REVIEW_POOL_SIZE);

  return selectReviewSession(pool, {
    now,
    sessionSize: input.sessionSize ?? DEFAULT_SESSION_SIZE,
  });
}

/** The whole backlog, so the UI can say what a session is a slice of. */
export async function countDuePuzzles(input: {
  db: Database;
  userId: string;
  now?: Date;
}): Promise<number> {
  const now = input.now ?? new Date();

  const [row] = await input.db
    .select({ due: count() })
    .from(schema.puzzles)
    .where(and(eq(schema.puzzles.userId, input.userId), lte(schema.puzzles.dueAt, now)));

  return row?.due ?? 0;
}

/**
 * Apply one review outcome to one puzzle.
 *
 * Returns null when the puzzle is not this user's, so a guessed id updates nothing: the read and
 * the write are both scoped by `userId`, not merely the read.
 */
export async function gradePuzzleReview(input: {
  db: Database;
  userId: string;
  puzzleId: string;
  outcome: ReviewOutcome;
  now?: Date;
}): Promise<ScheduledReview | null> {
  const now = input.now ?? new Date();

  const puzzle = await input.db.query.puzzles.findFirst({
    where: and(eq(schema.puzzles.id, input.puzzleId), eq(schema.puzzles.userId, input.userId)),
  });
  if (!puzzle) return null;

  const scheduled = reviewPuzzle(
    {
      intervalDays: puzzle.intervalDays,
      ease: puzzle.ease,
      repetitions: puzzle.repetitions,
      lapses: puzzle.lapses,
    },
    input.outcome,
    now,
  );

  await input.db
    .update(schema.puzzles)
    .set({
      dueAt: scheduled.dueAt,
      intervalDays: scheduled.intervalDays,
      ease: scheduled.ease,
      repetitions: scheduled.repetitions,
      lapses: scheduled.lapses,
    })
    .where(and(eq(schema.puzzles.id, input.puzzleId), eq(schema.puzzles.userId, input.userId)));

  return scheduled;
}
