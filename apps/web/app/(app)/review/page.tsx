import Link from 'next/link';

import { db } from '@chessedu/db';

import { countDuePuzzles, loadReviewSession } from '../../../lib/review-queue';
import { requireUser } from '../../../lib/session';
import { type ReviewCard, ReviewSession } from './review-session';

/**
 * The review queue, scoped to the signed-in user. Which puzzles appear and in what order is the
 * policy in packages/chess (ADR 0002); this page only supplies the session and the board.
 */
export default async function ReviewPage() {
  const user = await requireUser();
  const database = db();
  const now = new Date();

  const [session, dueCount] = await Promise.all([
    loadReviewSession({ db: database, userId: user.id, now }),
    countDuePuzzles({ db: database, userId: user.id, now }),
  ]);

  if (session.length === 0) {
    return (
      <div className="max-w-xl space-y-4">
        <h1 className="text-2xl font-semibold tracking-tight">Nothing due</h1>
        <p className="text-sm text-neutral-600 dark:text-neutral-400">
          Puzzles come from your own blunders, and each one comes back on its own schedule. When
          analysis finds a new mistake — or a puzzle you have seen falls due — it will be here.
        </p>
        <Link
          href="/dashboard"
          className="inline-block rounded-lg bg-neutral-900 px-4 py-2 text-sm font-medium text-white dark:bg-white dark:text-neutral-900"
        >
          Back to dashboard
        </Link>
      </div>
    );
  }

  // Only what the board needs crosses to the client; the SM-2 columns stay on the server.
  const cards: ReviewCard[] = session.map((puzzle) => ({
    id: puzzle.id,
    fen: puzzle.fen,
    solutionUci: puzzle.solutionUci,
    playedUci: puzzle.playedUci,
    themes: puzzle.themes,
  }));

  return <ReviewSession puzzles={cards} dueCount={dueCount} />;
}
