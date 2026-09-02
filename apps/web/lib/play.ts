import { and, desc, eq } from 'drizzle-orm';

import {
  STRENGTH_WINDOW,
  type Recommendation,
  dominantRating,
  recommendBotLevel,
  recommendationMessage,
} from '@chessedu/chess';
import { db, schema } from '@chessedu/db';

/**
 * Choosing the opponent a player is offered.
 *
 * The decision itself is pure and lives in `packages/chess/src/recommend.ts`. This module only
 * fetches what that decision needs: the player's own recent rated ratings.
 */

export interface PlayRecommendation extends Recommendation {
  /** The time control the rating came from, so the number can be attributed. */
  timeClass: string | null;
  rating: number | null;
  /** One line explaining the choice. */
  message: string;
}

/**
 * Read the player's rating from their own recent games and turn it into a starting rung.
 *
 * Uses the same window as the strength dashboard, so the two never disagree about which games
 * describe the player as they are now. A player with no linked account, or none analysed, gets
 * the default rung rather than nothing — the page has to open on something.
 */
export async function loadPlayRecommendation(userId: string): Promise<PlayRecommendation> {
  const database = db();

  const account = await database.query.chessAccounts.findFirst({
    where: eq(schema.chessAccounts.userId, userId),
  });

  if (!account) {
    const recommendation = recommendBotLevel({ rating: null });
    return {
      ...recommendation,
      timeClass: null,
      rating: null,
      message: recommendationMessage(recommendation),
    };
  }

  const rows = await database
    .select({
      timeClass: schema.games.timeClass,
      userRating: schema.games.userRating,
      rated: schema.games.rated,
    })
    .from(schema.games)
    .where(
      and(eq(schema.games.chessAccountId, account.id), eq(schema.games.rated, true)),
    )
    .orderBy(desc(schema.games.playedAt))
    .limit(STRENGTH_WINDOW);

  const dominant = dominantRating(rows);
  const recommendation = recommendBotLevel({ rating: dominant?.rating ?? null });

  return {
    ...recommendation,
    timeClass: dominant?.timeClass ?? null,
    rating: dominant?.rating ?? null,
    message: recommendationMessage(recommendation, dominant?.timeClass),
  };
}
