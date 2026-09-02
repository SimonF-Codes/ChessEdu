'use server';

import { revalidatePath } from 'next/cache';

import { type ReviewOutcome, outcomeFor } from '@chessedu/chess';
import { db } from '@chessedu/db';

import { gradePuzzleReview } from '../../../lib/review-queue';
import { requireUser } from '../../../lib/session';

/**
 * A thin wrapper over lib/review-queue.ts. All it adds is the session — which is the point: the
 * user id is re-derived here from the cookie and never accepted from the client, so a guessed
 * puzzle id grades nothing.
 *
 * The client sends what the board observed (wrong moves, whether the answer was revealed, how
 * long it took), not a grade. Turning that into an SM-2 grade is a domain rule and stays in
 * `packages/chess`.
 */

export interface AttemptReport {
  puzzleId: string;
  wrongAttempts: number;
  revealed: boolean;
  elapsedMs: number;
}

export type GradeReviewResult =
  { ok: true; outcome: ReviewOutcome; intervalDays: number } | { ok: false };

/** An hour of wall clock is a walked-away session, not a slow solve. */
const MAX_ELAPSED_MS = 60 * 60 * 1000;

export async function gradeReviewAction(report: AttemptReport): Promise<GradeReviewResult> {
  const user = await requireUser();

  const outcome = outcomeFor({
    wrongAttempts: Math.max(0, Math.floor(report.wrongAttempts)),
    revealed: report.revealed,
    elapsedMs: Math.min(MAX_ELAPSED_MS, Math.max(0, report.elapsedMs)),
  });

  const scheduled = await gradePuzzleReview({
    db: db(),
    userId: user.id,
    puzzleId: report.puzzleId,
    outcome,
  });
  if (!scheduled) return { ok: false };

  revalidatePath('/review');
  return { ok: true, outcome, intervalDays: scheduled.intervalDays };
}
