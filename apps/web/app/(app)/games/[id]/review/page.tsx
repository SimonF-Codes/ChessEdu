import Link from 'next/link';
import { notFound } from 'next/navigation';

import { db } from '@chessedu/db';

import { loadGameReview } from '../../../../../lib/review-data';
import { requireUser } from '../../../../../lib/session';
import { GameWalkthrough } from './walkthrough';

/**
 * One game, walked through. The review is assembled on the server from `move_analysis`; the
 * coach's prose is a separate action the reader triggers, because it costs a model call.
 */
export default async function GameReviewPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requireUser();

  const review = await loadGameReview({ db: db(), userId: user.id, gameId: id });
  if (review === null) notFound();

  return (
    <div className="space-y-6">
      <Link href="/dashboard" className="text-sm text-neutral-500 hover:underline">
        ← Back to games
      </Link>
      <GameWalkthrough
        review={review}
        // Formatted here so the client renders a fixed string: a locale date computed in the
        // browser and on the server will not agree.
        playedAtLabel={review.playedAt.toISOString().slice(0, 10)}
      />
    </div>
  );
}
