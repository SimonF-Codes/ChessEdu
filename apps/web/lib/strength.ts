import { desc, eq } from 'drizzle-orm';

import {
  type Color,
  type GameResult,
  STRENGTH_WINDOW,
  type StrengthProfile,
  buildStrengthProfile,
  phaseBreakdownFor,
} from '@chessedu/chess';
import { type Database, schema } from '@chessedu/db';

/**
 * Reading the per-phase strength model for the dashboard.
 *
 * The model itself lives in `@chessedu/chess`; this file only fetches the rows and narrows each
 * game to the side the user played. Nothing here computes a chess judgement, and nothing here
 * asks a model for a number — see section 9 of docs/architecture.md.
 */

/** Games listed under the profile. Enough to recognise the run of form, not a full archive. */
export const RECENT_GAMES = 10;

/** One game as the dashboard query returns it. */
export interface GameRow {
  id: string;
  url: string;
  playedAt: Date;
  userColor: Color;
  userResult: GameResult;
  opponentUsername: string;
  opponentRating: number | null;
  eco: string | null;
  accuracyWhite: number | null;
  accuracyBlack: number | null;
  /** `game_analysis.phase_breakdown`, jsonb and therefore untyped until parsed. */
  phaseBreakdown: unknown;
}

export interface RecentGame {
  id: string;
  url: string;
  playedAt: Date;
  userColor: Color;
  userResult: GameResult;
  opponentUsername: string;
  opponentRating: number | null;
  eco: string | null;
  /** The user's own accuracy in that game. Null until the worker has analysed it. */
  accuracy: number | null;
}

export interface StrengthDashboard {
  profile: StrengthProfile;
  /** Games in the window, analysed or not. */
  games: number;
  analysedGames: number;
  /** Games still waiting on the worker. The profile does not include them. */
  pendingGames: number;
  recent: RecentGame[];
}

/**
 * Fold the rows into the profile plus the list under it.
 *
 * Split out from the query so it can be tested without a database: the part worth testing is
 * picking the right side of each game and not counting an unanalysed one.
 */
export function summariseGames(
  rows: readonly GameRow[],
  recentLimit = RECENT_GAMES,
): StrengthDashboard {
  const breakdowns = rows
    .map((row) => phaseBreakdownFor(row.phaseBreakdown, row.userColor))
    .filter((breakdown) => breakdown !== null);

  const recent = rows.slice(0, recentLimit).map((row) => ({
    id: row.id,
    url: row.url,
    playedAt: row.playedAt,
    userColor: row.userColor,
    userResult: row.userResult,
    opponentUsername: row.opponentUsername,
    opponentRating: row.opponentRating,
    eco: row.eco,
    accuracy: row.userColor === 'w' ? row.accuracyWhite : row.accuracyBlack,
  }));

  return {
    profile: buildStrengthProfile(breakdowns),
    games: rows.length,
    analysedGames: breakdowns.length,
    pendingGames: rows.length - breakdowns.length,
    recent,
  };
}

/**
 * Read the strength dashboard for one linked account.
 *
 * The caller has already derived the user from the session and owns this account — every query
 * below is scoped by `chessAccountId`, which is only reachable through the user's own id.
 */
export async function loadStrengthDashboard(
  database: Database,
  chessAccountId: string,
  limit = STRENGTH_WINDOW,
): Promise<StrengthDashboard> {
  const rows = await database
    .select({
      id: schema.games.id,
      url: schema.games.url,
      playedAt: schema.games.playedAt,
      userColor: schema.games.userColor,
      userResult: schema.games.userResult,
      opponentUsername: schema.games.opponentUsername,
      opponentRating: schema.games.opponentRating,
      eco: schema.games.eco,
      accuracyWhite: schema.gameAnalysis.accuracyWhite,
      accuracyBlack: schema.gameAnalysis.accuracyBlack,
      phaseBreakdown: schema.gameAnalysis.phaseBreakdown,
    })
    .from(schema.games)
    // Left, not inner: a game the worker has not reached yet still belongs on the dashboard,
    // counted as pending rather than silently missing.
    .leftJoin(schema.gameAnalysis, eq(schema.gameAnalysis.gameId, schema.games.id))
    .where(eq(schema.games.chessAccountId, chessAccountId))
    .orderBy(desc(schema.games.playedAt))
    .limit(limit);

  return summariseGames(rows);
}
