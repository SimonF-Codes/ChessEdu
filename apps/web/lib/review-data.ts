import { and, asc, eq } from 'drizzle-orm';

import { type GameReview, buildGameReview } from '@chessedu/chess';
import { type Database, schema } from '@chessedu/db';

/**
 * Reading one game's walkthrough out of Postgres.
 *
 * The ownership chain is enforced in the query itself: the game is joined to `chess_account`
 * and filtered by the session's user id, so a game belonging to someone else is not "hidden",
 * it is unreachable. See the security posture in docs/architecture.md.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function loadGameReview(input: {
  db: Database;
  userId: string;
  gameId: string;
}): Promise<GameReview | null> {
  // The id comes from the URL. Postgres would raise on a malformed uuid comparison, and a
  // 404 is the honest answer anyway.
  if (!UUID.test(input.gameId)) return null;

  const [row] = await input.db
    .select({ game: schema.games })
    .from(schema.games)
    .innerJoin(schema.chessAccounts, eq(schema.games.chessAccountId, schema.chessAccounts.id))
    .where(
      and(eq(schema.games.id, input.gameId), eq(schema.chessAccounts.userId, input.userId)),
    )
    .limit(1);

  if (!row) return null;
  const game = row.game;

  const [moves, analysis] = await Promise.all([
    input.db
      .select()
      .from(schema.moves)
      .where(eq(schema.moves.gameId, game.id))
      .orderBy(asc(schema.moves.ply)),
    input.db
      .select()
      .from(schema.moveAnalysis)
      .where(eq(schema.moveAnalysis.gameId, game.id))
      .orderBy(asc(schema.moveAnalysis.ply)),
  ]);

  return buildGameReview({
    game: {
      id: game.id,
      userColor: game.userColor,
      userResult: game.userResult,
      opponentUsername: game.opponentUsername,
      opponentRating: game.opponentRating,
      playedAt: game.playedAt,
      timeControl: game.timeControl,
      eco: game.eco,
      ecoUrl: game.ecoUrl,
      finalFen: game.finalFen,
    },
    moves: moves.map((move) => ({
      ply: move.ply,
      color: move.color,
      san: move.san,
      uci: move.uci,
      fenBefore: move.fenBefore,
      clockMs: move.clockMs,
    })),
    analysis: analysis.map((row) => ({
      ply: row.ply,
      evalCp: row.evalCp,
      mateIn: row.mateIn,
      bestMoveUci: row.bestMoveUci,
      pv: row.pv,
      centipawnLoss: row.centipawnLoss,
      winPercentLoss: row.winPercentLoss,
      classification: row.classification,
      phase: row.phase,
      isCritical: row.isCritical,
    })),
  });
}
