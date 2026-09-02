import { START_FEN, defaultBook, positionKey } from './book';
import { keyAfter } from './repertoire';

import type { BookMove, OpeningBook } from './book';
import type { Classification, Color } from './classify';
import type { RepertoireGame } from './repertoire';

/**
 * Where a game leaves mainline theory, and — from the engine, never from here — what that
 * cost.
 *
 * This is the part of the repertoire that teaches something. Knowing which openings a player
 * plays is a tally; knowing that they abandon the Caro-Kann at move four, every time, for a
 * move Stockfish scores at ninety centipawns, is a lesson.
 */

/**
 * Why a game stopped matching the book.
 *
 * The distinction matters because only one of them is a mistake worth showing: every game
 * leaves the book eventually, and "theory ran out" is not a lesson.
 */
export type DeviationKind =
  /** The position had known continuations and this move was not one of them. */
  | 'novelty'
  /** The book knows this position but has nothing to say about what follows. */
  | 'out-of-book';

export interface Deviation {
  gameId: string;
  kind: DeviationKind;
  /** 1-based ply of the deviating move. */
  ply: number;
  /** The side that played it. */
  color: Color;
  /** True when that side was the player rather than their opponent. */
  byPlayer: boolean;
  san: string;
  uci: string;
  /** The position it was played from. */
  fenBefore: string;
  key: string;
  /** The moves that led here, so the line can be shown. */
  line: string[];
  /** How theory names the deepest named position on that line. Null if it never named one. */
  eco: string | null;
  name: string | null;
  /** What theory plays from this position. Empty for an `out-of-book` deviation. */
  bookMoves: readonly BookMove[];
}

/** One row of `move_analysis`. The only source of a number in this file. */
export interface PlyAnalysis {
  gameId: string;
  ply: number;
  centipawnLoss: number;
  winPercentLoss: number;
  classification: Classification;
  bestMoveUci: string | null;
}

/** The same deviation played across many games — a habit rather than an incident. */
export interface RecurringDeviation {
  key: string;
  /** Plies into the game, i.e. the length of `line`. */
  ply: number;
  line: string[];
  eco: string | null;
  name: string | null;
  bookMoves: readonly BookMove[];
  /** What was played instead, most frequent first. */
  played: { san: string; uci: string; games: number }[];
  games: number;
  wins: number;
  draws: number;
  losses: number;
  /** Points per game from the player's perspective, 0..1. */
  score: number;
  /** Mean centipawn loss Stockfish assigned to the deviating move. Null if none were analysed. */
  avgCentipawnLoss: number | null;
  worstClassification: Classification | null;
  /** `games x avgCentipawnLoss`: what the habit costs in total, not per game. Zero if unknown. */
  cost: number;
  gameIds: string[];
}

export interface RankOptions {
  book?: OpeningBook;
  /** Rows from `move_analysis`. Without them the ranking is by frequency alone. */
  analysis?: Iterable<PlyAnalysis>;
  /** Whose deviations to count. Defaults to the player's own. */
  by?: 'player' | 'opponent' | 'either';
  limit?: number;
}

const SEVERITY: Record<Classification, number> = {
  good: 0,
  inaccuracy: 1,
  mistake: 2,
  blunder: 3,
};

/**
 * The first move of a game that theory does not know.
 *
 * Only the first: once a game is off book every position after it is off book too, so there
 * is exactly one deviation per game, and whose it was decides who it teaches. Returns null
 * for a game that never leaves the book — a short game that ended in theory.
 */
export function findDeviation(
  game: RepertoireGame,
  book: OpeningBook = defaultBook(),
): Deviation | null {
  let key = positionKey(START_FEN);
  let named: { eco: string; name: string } | null = null;
  const line: string[] = [];

  for (const [index, move] of game.moves.entries()) {
    const position = book.get(key);
    if (!position) return null;
    if (position.eco !== null && position.name !== null) {
      named = { eco: position.eco, name: position.name };
    }

    const theory = position.moves.find((candidate) => candidate.uci === move.uci);
    if (!theory) {
      const color: Color = move.ply % 2 === 1 ? 'w' : 'b';
      return {
        gameId: game.id,
        kind: position.moves.length > 0 ? 'novelty' : 'out-of-book',
        ply: move.ply,
        color,
        byPlayer: color === game.color,
        san: move.san,
        uci: move.uci,
        fenBefore: move.fenBefore,
        key,
        line: [...line],
        eco: named?.eco ?? null,
        name: named?.name ?? null,
        bookMoves: position.moves,
      };
    }

    line.push(move.san);
    key = keyAfter(move, game.moves[index + 1]);
  }

  return null;
}

interface Group {
  deviation: Deviation;
  games: number;
  wins: number;
  draws: number;
  losses: number;
  played: Map<string, { san: string; uci: string; games: number }>;
  gameIds: string[];
  centipawnLosses: number[];
  worst: Classification | null;
}

/**
 * Group every game's deviation by the position it leaves, and rank the groups by what they
 * cost in total.
 *
 * Only novelties are ranked: an `out-of-book` ending means theory stopped, which is not
 * something the player did. The cost is `games x average centipawn loss`, so a small error
 * repeated forty times outranks a disaster played once — which is the right way round for
 * something to practise.
 *
 * Every centipawn here is read from the `move_analysis` rows passed in. Nothing in this
 * function decides that a move was bad; it reports what Stockfish already concluded.
 */
export function rankDeviations(
  games: Iterable<RepertoireGame>,
  options: RankOptions = {},
): RecurringDeviation[] {
  const book = options.book ?? defaultBook();
  const by = options.by ?? 'player';

  const analysis = new Map<string, PlyAnalysis>();
  for (const row of options.analysis ?? []) {
    analysis.set(`${row.gameId}:${row.ply}`, row);
  }

  const groups = new Map<string, Group>();

  for (const game of games) {
    const deviation = findDeviation(game, book);
    if (!deviation || deviation.kind !== 'novelty') continue;
    if (by === 'player' && !deviation.byPlayer) continue;
    if (by === 'opponent' && deviation.byPlayer) continue;

    let group = groups.get(deviation.key);
    if (!group) {
      group = {
        deviation,
        games: 0,
        wins: 0,
        draws: 0,
        losses: 0,
        played: new Map(),
        gameIds: [],
        centipawnLosses: [],
        worst: null,
      };
      groups.set(deviation.key, group);
    }

    group.games += 1;
    if (game.result === 'win') group.wins += 1;
    else if (game.result === 'draw') group.draws += 1;
    else group.losses += 1;
    group.gameIds.push(game.id);

    const played = group.played.get(deviation.uci);
    if (played) played.games += 1;
    else group.played.set(deviation.uci, { san: deviation.san, uci: deviation.uci, games: 1 });

    const row = analysis.get(`${game.id}:${deviation.ply}`);
    if (row) {
      group.centipawnLosses.push(row.centipawnLoss);
      if (group.worst === null || SEVERITY[row.classification] > SEVERITY[group.worst]) {
        group.worst = row.classification;
      }
    }
  }

  const ranked = [...groups.values()].map((group): RecurringDeviation => {
    const avgCentipawnLoss =
      group.centipawnLosses.length === 0
        ? null
        : group.centipawnLosses.reduce((sum, loss) => sum + loss, 0) / group.centipawnLosses.length;

    return {
      key: group.deviation.key,
      ply: group.deviation.line.length,
      line: group.deviation.line,
      eco: group.deviation.eco,
      name: group.deviation.name,
      bookMoves: group.deviation.bookMoves,
      played: [...group.played.values()].sort(
        (a, b) => b.games - a.games || a.san.localeCompare(b.san),
      ),
      games: group.games,
      wins: group.wins,
      draws: group.draws,
      losses: group.losses,
      score: (group.wins + group.draws / 2) / group.games,
      avgCentipawnLoss,
      worstClassification: group.worst,
      cost: group.games * (avgCentipawnLoss ?? 0),
      gameIds: group.gameIds,
    };
  });

  ranked.sort((a, b) => b.cost - a.cost || b.games - a.games || a.key.localeCompare(b.key));
  return options.limit === undefined ? ranked : ranked.slice(0, options.limit);
}
