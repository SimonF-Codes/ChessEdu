import { and, asc, desc, eq, inArray, isNull, min } from 'drizzle-orm';

import {
  type LineAttemptRecord,
  type PlyAttempt,
  type ReviewOutcome,
  type ScheduledReview,
  INITIAL_SRS_STATE,
  OUTCOME_GRADES,
  gradeReview,
  isGradedAttempt,
  learnerPlies,
  lineOutcome,
  normaliseAttempt,
  selectNextLine,
} from '@chessedu/chess';
import { type Database, type OpeningLinePly, schema } from '@chessedu/db';

/**
 * Reading the line-drill queue and writing back what an attempt showed.
 *
 * Plain functions taking a database, so they are tested against Postgres without Next.js in the
 * way; app/(app)/lines/actions.ts adds the session. `opening_line` is a shared catalogue, but
 * `line_review` and `line_attempt` are the user's, and every query on them is scoped by a
 * `userId` that only ever comes from the session.
 *
 * The rules — the grade an attempt earns, what a valid attempt looks like, which line is next —
 * are pure, in packages/chess/src/line-drill.ts. The schedule is srs.ts, unchanged. See
 * docs/adr/0006-opening-line-drill.md.
 */

/** How many past attempts the history reads. Enough for "missed N times running" to mean something. */
export const LINE_HISTORY_LIMIT = 10;

export interface StoredLine {
  id: string;
  key: string;
  eco: string;
  name: string;
  learnerColor: 'w' | 'b';
  plies: OpeningLinePly[];
}

export interface LineQueue {
  /** The line to drill now, or null when nothing is due and nothing is new. */
  next: StoredLine | null;
  /** Lines the user has met that are due now. */
  due: number;
  /** Lines the user has never attempted. */
  unseen: number;
  /** Live lines in the family. */
  total: number;
  /** When the soonest scheduled line comes due, for the "nothing to do" state. */
  nextDueAt: Date | null;
}

const LINE_COLUMNS = {
  id: schema.openingLines.id,
  key: schema.openingLines.key,
  eco: schema.openingLines.eco,
  name: schema.openingLines.name,
  learnerColor: schema.openingLines.learnerColor,
  plies: schema.openingLines.plies,
} as const;

/** The family's live lines, each with this user's due date if they have one. */
export async function loadLineQueue(input: {
  db: Database;
  userId: string;
  family: string;
  now?: Date;
}): Promise<LineQueue> {
  const now = input.now ?? new Date();

  const rows = await input.db
    .select({ ...LINE_COLUMNS, dueAt: schema.lineReviews.dueAt })
    .from(schema.openingLines)
    .leftJoin(
      schema.lineReviews,
      and(
        eq(schema.lineReviews.lineId, schema.openingLines.id),
        eq(schema.lineReviews.userId, input.userId),
      ),
    )
    .where(and(eq(schema.openingLines.family, input.family), isNull(schema.openingLines.retiredAt)))
    .orderBy(asc(schema.openingLines.key));

  const next = selectNextLine(rows, now);
  const scheduled = rows.filter((row) => row.dueAt !== null);
  const upcoming = scheduled
    .map((row) => row.dueAt!)
    .filter((dueAt) => dueAt.getTime() > now.getTime())
    .sort((a, b) => a.getTime() - b.getTime());

  return {
    next: next
      ? {
          id: next.id,
          key: next.key,
          eco: next.eco,
          name: next.name,
          learnerColor: next.learnerColor,
          plies: next.plies,
        }
      : null,
    due: scheduled.length - upcoming.length,
    unseen: rows.length - scheduled.length,
    total: rows.length,
    nextDueAt: upcoming[0] ?? null,
  };
}

/** One line, whatever its state — for the history view of a line just drilled. */
export async function loadLine(input: {
  db: Database;
  lineId: string;
}): Promise<StoredLine | null> {
  const [row] = await input.db
    .select(LINE_COLUMNS)
    .from(schema.openingLines)
    .where(eq(schema.openingLines.id, input.lineId))
    .limit(1);
  return row ?? null;
}

export interface RecordedAttempt {
  attemptId: string;
  /** What the attempt earned. Applied to the schedule only when `graded`. */
  outcome: ReviewOutcome;
  /** False for a practice replay of a line that was not due. */
  graded: boolean;
  /** The line's schedule after this attempt — unchanged by a practice replay. */
  scheduled: ScheduledReview;
}

/**
 * Record one attempt at one line: a `line_attempt` row per learner move, and — if the line was
 * due — its SM-2 state advanced by the outcome those rows imply.
 *
 * A replay is a new attempt, never an edit of the last one. Whether it grades is decided under
 * the row lock by `isGradedAttempt`: only the attempt that meets a due (or never-tried) line
 * moves the schedule; replays after it are practice (ADR 0007).
 *
 * Returns null — and writes nothing — when the line does not exist or the attempt does not fit
 * it. The outcome is derived here from the per-ply results; the client never sends a grade.
 */
export async function recordLineAttempt(input: {
  db: Database;
  userId: string;
  lineId: string;
  plies: readonly PlyAttempt[];
  now?: Date;
}): Promise<RecordedAttempt | null> {
  const now = input.now ?? new Date();

  const line = await loadLine({ db: input.db, lineId: input.lineId });
  if (!line) return null;

  const plies = normaliseAttempt(line, input.plies);
  if (!plies) return null;

  const outcome = lineOutcome(plies, learnerPlies(line).length);
  const attemptId = crypto.randomUUID();

  const { graded, scheduled } = await input.db.transaction(async (tx) => {
    const [existing] = await tx
      .select({
        dueAt: schema.lineReviews.dueAt,
        intervalDays: schema.lineReviews.intervalDays,
        ease: schema.lineReviews.ease,
        repetitions: schema.lineReviews.repetitions,
        lapses: schema.lineReviews.lapses,
      })
      .from(schema.lineReviews)
      .where(
        and(eq(schema.lineReviews.userId, input.userId), eq(schema.lineReviews.lineId, line.id)),
      )
      .for('update');

    const graded = isGradedAttempt(existing?.dueAt ?? null, now);

    await tx.insert(schema.lineAttempts).values(
      plies.map((ply) => ({
        attemptId,
        ply: ply.ply,
        userId: input.userId,
        lineId: line.id,
        result: ply.result,
        wrongUci: ply.wrongUci,
        elapsedMs: ply.elapsedMs,
        graded,
        attemptedAt: now,
      })),
    );

    // Practice: the rows above are the whole effect. `existing` is set, since only a line with a
    // future due date can be practice.
    if (!graded && existing) return { graded, scheduled: existing };

    const next = gradeReview(existing ?? INITIAL_SRS_STATE, OUTCOME_GRADES[outcome], now);

    const state = {
      dueAt: next.dueAt,
      intervalDays: next.intervalDays,
      ease: next.ease,
      repetitions: next.repetitions,
      lapses: next.lapses,
    };
    await tx
      .insert(schema.lineReviews)
      .values({ userId: input.userId, lineId: line.id, ...state })
      .onConflictDoUpdate({
        target: [schema.lineReviews.userId, schema.lineReviews.lineId],
        set: state,
      });

    return { graded: true, scheduled: next };
  });

  return { attemptId, outcome, graded, scheduled };
}

/** This user's recent attempts at one line, newest first, each with its plies in order. */
export async function loadLineHistory(input: {
  db: Database;
  userId: string;
  lineId: string;
  limit?: number;
}): Promise<LineAttemptRecord[]> {
  const scope = and(
    eq(schema.lineAttempts.userId, input.userId),
    eq(schema.lineAttempts.lineId, input.lineId),
  );

  const recent = await input.db
    .select({
      attemptId: schema.lineAttempts.attemptId,
      attemptedAt: min(schema.lineAttempts.attemptedAt),
      graded: schema.lineAttempts.graded,
    })
    .from(schema.lineAttempts)
    .where(scope)
    .groupBy(schema.lineAttempts.attemptId, schema.lineAttempts.graded)
    .orderBy(desc(min(schema.lineAttempts.attemptedAt)))
    .limit(input.limit ?? LINE_HISTORY_LIMIT);
  if (recent.length === 0) return [];

  const rows = await input.db
    .select({
      attemptId: schema.lineAttempts.attemptId,
      ply: schema.lineAttempts.ply,
      result: schema.lineAttempts.result,
      elapsedMs: schema.lineAttempts.elapsedMs,
      wrongUci: schema.lineAttempts.wrongUci,
    })
    .from(schema.lineAttempts)
    .where(
      and(
        scope,
        inArray(
          schema.lineAttempts.attemptId,
          recent.map((r) => r.attemptId),
        ),
      ),
    )
    .orderBy(asc(schema.lineAttempts.ply));

  return recent.map(({ attemptId, attemptedAt, graded }) => ({
    attemptId,
    attemptedAt: attemptedAt!,
    graded,
    plies: rows
      .filter((row) => row.attemptId === attemptId)
      .map(({ ply, result, elapsedMs, wrongUci }) => ({ ply, result, elapsedMs, wrongUci })),
  }));
}
