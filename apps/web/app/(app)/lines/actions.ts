'use server';

import {
  type LineHistory,
  type PlyAttempt,
  type ReviewOutcome,
  summariseLineHistory,
} from '@chessedu/chess';
import { db } from '@chessedu/db';

import { loadLine, loadLineHistory, recordLineAttempt } from '../../../lib/line-drill';
import { requireUser } from '../../../lib/session';

/**
 * A thin wrapper over lib/line-drill.ts that adds the session. The user id is re-derived from the
 * cookie, never accepted from the client.
 *
 * The client reports what the board saw on each move — first try, second try, revealed, or
 * abandoned — and never a grade. The grade is derived in `packages/chess` (ADR 0006).
 */

export interface LineAttemptReport {
  lineId: string;
  plies: PlyAttempt[];
}

export type RecordLineResult =
  { ok: true; outcome: ReviewOutcome; intervalDays: number; history: LineHistory } | { ok: false };

export async function recordLineAttemptAction(
  report: LineAttemptReport,
): Promise<RecordLineResult> {
  const user = await requireUser();
  const database = db();

  const recorded = await recordLineAttempt({
    db: database,
    userId: user.id,
    lineId: report.lineId,
    plies: Array.isArray(report.plies) ? report.plies : [],
  });
  if (!recorded) return { ok: false };

  const [line, attempts] = await Promise.all([
    loadLine({ db: database, lineId: report.lineId }),
    loadLineHistory({ db: database, userId: user.id, lineId: report.lineId }),
  ]);
  if (!line) return { ok: false };

  // No revalidatePath here, unlike /review: re-rendering the page would swap in the next line
  // and remount the board before the learner has seen how this one went. "Next line" refreshes.
  return {
    ok: true,
    outcome: recorded.outcome,
    intervalDays: recorded.scheduled.intervalDays,
    history: summariseLineHistory(line, attempts),
  };
}
