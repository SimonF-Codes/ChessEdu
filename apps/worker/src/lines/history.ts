import { sql } from 'drizzle-orm';

import {
  type FacedReplies,
  type FamilyRecord,
  ROOT_SEARCH_PLIES,
  foldFamilyRecords,
  positionKey,
} from '@chessedu/chess';
import type { Database } from '@chessedu/db';

/**
 * Reading one player's history for the opening choice (docs/adr/0009-openings-from-the-games.md).
 *
 * Only `game` and `move` are read. `move_analysis` is not: it was still filling when the choice
 * was designed, and a ranking that moved as the backlog drained would not be reproducible.
 * Grouping into families is the pure `foldFamilyRecords`; this file only counts.
 */

/**
 * Every opening family the account has played, per side: games, points and the first
 * `ROOT_SEARCH_PLIES` moves of each game, grouped. Games with no `eco_url` are left out.
 */
export async function loadFamilyRecords(input: {
  db: Database;
  chessAccountId: string;
}): Promise<FamilyRecord[]> {
  const rows = await input.db.execute<{
    color: 'w' | 'b';
    eco_url: string;
    eco: string | null;
    sans: string[] | null;
    games: number;
    points: number;
  }>(sql`
    with opened as (
      select
        g.user_color,
        g.eco_url,
        g.eco,
        case g.user_result when 'win' then 1.0 when 'draw' then 0.5 else 0.0 end as points,
        (
          select array_agg(m.san order by m.ply)
          from move m
          where m.game_id = g.id and m.ply <= ${ROOT_SEARCH_PLIES}
        ) as sans
      from game g
      where g.chess_account_id = ${input.chessAccountId} and g.eco_url is not null
    )
    select
      user_color as color,
      eco_url,
      eco,
      sans,
      count(*)::int as games,
      sum(points)::float8 as points
    from opened
    group by user_color, eco_url, eco, sans
  `);

  return foldFamilyRecords(
    rows.map((row) => ({
      color: row.color,
      ecoUrl: row.eco_url,
      eco: row.eco,
      sans: row.sans ?? [],
      games: row.games,
      points: row.points,
    })),
  );
}

/**
 * What the account's opponents played, by position, in its games as `color`, up to `maxPly`.
 * Positions are keyed without the move counters, so a transposition counts with the line it
 * transposes into. The player's own moves are not counted: they are not replies faced.
 */
export async function loadFacedReplies(input: {
  db: Database;
  chessAccountId: string;
  color: 'w' | 'b';
  maxPly: number;
}): Promise<FacedReplies> {
  const rows = await input.db.execute<{ fen_before: string; uci: string; games: number }>(sql`
    select m.fen_before, m.uci, count(*)::int as games
    from move m
    join game g on g.id = m.game_id
    where g.chess_account_id = ${input.chessAccountId}
      and g.user_color = ${input.color}
      and m.color <> g.user_color
      and m.ply <= ${input.maxPly}
    group by m.fen_before, m.uci
  `);

  const faced = new Map<string, Map<string, number>>();
  for (const row of rows) {
    const key = positionKey(row.fen_before);
    let replies = faced.get(key);
    if (!replies) {
      replies = new Map();
      faced.set(key, replies);
    }
    replies.set(row.uci, (replies.get(row.uci) ?? 0) + row.games);
  }
  return faced;
}
