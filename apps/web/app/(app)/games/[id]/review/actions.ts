'use server';

import { db } from '@chessedu/db';

import { type MoveComment, annotateReview } from '../../../../../lib/coach';
import { anthropicModel, isCoachConfigured } from '../../../../../lib/coach/anthropic-model';
import { loadGameReview } from '../../../../../lib/review-data';
import { requireUser } from '../../../../../lib/session';

/**
 * Ask the coach to explain this game's key moments.
 *
 * A separate action rather than part of the page render, because it costs a model call: the
 * walkthrough itself is free and always there. The game id arrives from the client and is
 * therefore worth nothing on its own — `loadGameReview` scopes it by the session's user.
 */

export type ExplainResult =
  | { ok: true; comments: MoveComment[] }
  | { ok: false; message: string };

export async function explainGameAction(gameId: string): Promise<ExplainResult> {
  const user = await requireUser();

  if (!isCoachConfigured()) {
    return {
      ok: false,
      message: 'Coaching is not configured on this deployment (no ANTHROPIC_API_KEY).',
    };
  }

  const review = await loadGameReview({ db: db(), userId: user.id, gameId });
  if (review === null) {
    return { ok: false, message: 'That game is not in your history.' };
  }
  if (!review.analysed) {
    return { ok: false, message: 'This game has not been analysed yet. Try again shortly.' };
  }
  if (review.keyMoments.length === 0) {
    return {
      ok: false,
      message: 'The engine found nothing worth explaining in this game — no mistakes to unpick.',
    };
  }

  try {
    const commentary = await annotateReview({ review, model: anthropicModel() });
    return { ok: true, comments: commentary.comments };
  } catch (error) {
    console.error('[coach] explaining game failed:', error);
    return { ok: false, message: 'The coach could not be reached. Try again in a moment.' };
  }
}
