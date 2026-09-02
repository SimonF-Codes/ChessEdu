import { and, desc, eq, inArray, lte } from 'drizzle-orm';

import {
  OPENING_MAX_PLY,
  type PlyAnalysis,
  type RecurringDeviation,
  type Repertoire,
  type RepertoireGame,
  buildRepertoire,
  rankDeviations,
} from '@chessedu/chess';
import { type ChessAccount, db, schema } from '@chessedu/db';

/**
 * Reading for the repertoire view.
 *
 * All the thinking is in `@chessedu/chess`; this file only fetches rows and hands them over.
 * Every query is scoped by the chess account, which is itself scoped by the session user —
 * see the ownership chain in docs/architecture.md.
 */

/** How many games to read. The opening tree flattens quickly; more games mostly cost latency. */
const GAME_LIMIT = 500;

export interface OpeningsView {
  account: ChessAccount;
  repertoire: Repertoire;
  /** The player's own recurring departures from theory, most costly first. */
  deviations: RecurringDeviation[];
  gameCount: number;
  /** True when no game in the window has been analysed, so no cost can be shown yet. */
  awaitingAnalysis: boolean;
}

export async function loadOpenings(userId: string): Promise<OpeningsView | null> {
  const database = db();

  const account = await database.query.chessAccounts.findFirst({
    where: eq(schema.chessAccounts.userId, userId),
  });
  if (!account) return null;

  const games = await database
    .select({
      id: schema.games.id,
      color: schema.games.userColor,
      result: schema.games.userResult,
    })
    .from(schema.games)
    .where(eq(schema.games.chessAccountId, account.id))
    .orderBy(desc(schema.games.playedAt))
    .limit(GAME_LIMIT);

  if (games.length === 0) {
    return {
      account,
      repertoire: buildRepertoire([]),
      deviations: [],
      gameCount: 0,
      awaitingAnalysis: false,
    };
  }

  const ids = games.map((game) => game.id);

  // Only the opening plies are needed, and only these columns of them.
  const [moves, analysis] = await Promise.all([
    database
      .select({
        gameId: schema.moves.gameId,
        ply: schema.moves.ply,
        san: schema.moves.san,
        uci: schema.moves.uci,
        fenBefore: schema.moves.fenBefore,
      })
      .from(schema.moves)
      .where(and(inArray(schema.moves.gameId, ids), lte(schema.moves.ply, OPENING_MAX_PLY))),
    database
      .select({
        gameId: schema.moveAnalysis.gameId,
        ply: schema.moveAnalysis.ply,
        centipawnLoss: schema.moveAnalysis.centipawnLoss,
        winPercentLoss: schema.moveAnalysis.winPercentLoss,
        classification: schema.moveAnalysis.classification,
        bestMoveUci: schema.moveAnalysis.bestMoveUci,
      })
      .from(schema.moveAnalysis)
      .where(
        and(inArray(schema.moveAnalysis.gameId, ids), lte(schema.moveAnalysis.ply, OPENING_MAX_PLY)),
      ),
  ]);

  const byGame = new Map<string, RepertoireGame['moves'][number][]>();
  for (const move of moves) {
    const bucket = byGame.get(move.gameId);
    if (bucket) bucket.push(move);
    else byGame.set(move.gameId, [move]);
  }
  for (const bucket of byGame.values()) bucket.sort((a, b) => a.ply - b.ply);

  const repertoireGames: RepertoireGame[] = games.map((game) => ({
    id: game.id,
    color: game.color,
    result: game.result,
    moves: byGame.get(game.id) ?? [],
  }));

  const plyAnalysis: PlyAnalysis[] = analysis.map((row) => ({
    gameId: row.gameId,
    ply: row.ply,
    centipawnLoss: row.centipawnLoss,
    winPercentLoss: row.winPercentLoss,
    classification: row.classification,
    bestMoveUci: row.bestMoveUci,
  }));

  return {
    account,
    repertoire: buildRepertoire(repertoireGames),
    deviations: rankDeviations(repertoireGames, { analysis: plyAnalysis, limit: 12 }),
    gameCount: games.length,
    awaitingAnalysis: plyAnalysis.length === 0,
  };
}
