import { Chess } from 'chess.js';

import { START_FEN, defaultBook, positionKey } from './book';
import { OPENING_MAX_PLY } from './phase';

import type { OpeningBook } from './book';
import type { Color } from './classify';
import type { GameResult } from './pgn';

/**
 * The repertoire the player actually plays, assembled from their own games.
 *
 * Not a generic opening book: every count here comes from games they played, and every score
 * is from their side of the board. Theory is laid over the top only to name the lines and to
 * mark where they left it — see book.ts and deviation.ts.
 */

/** The columns of `moves` this needs. Deliberately fewer than the table has. */
export interface RepertoireMove {
  /** 1-based, counting each half-move. */
  ply: number;
  san: string;
  uci: string;
  fenBefore: string;
}

export interface RepertoireGame {
  id: string;
  /** The colour the player had. */
  color: Color;
  /** The result from the player's perspective. */
  result: GameResult;
  moves: readonly RepertoireMove[];
}

export interface RepertoireNode {
  /** Position key of the position this node *is*; the root is the starting position. */
  key: string;
  /** The move that reached this node. Null at the root. */
  move: { san: string; uci: string } | null;
  /** Plies from the start. 0 at the root. */
  ply: number;
  /** Whose move it is here. */
  turn: Color;
  /**
   * The deepest theory name on the path to this node, so an unnamed continuation of the
   * Najdorf still reads as the Najdorf. Null until the line reaches a named position.
   */
  eco: string | null;
  name: string | null;
  /**
   * True while the line has not yet left theory. Once a node is off book so is everything
   * below it, even where the line transposes back into a position the book knows: this
   * describes the player's line, not the position.
   */
  inBook: boolean;
  games: number;
  wins: number;
  draws: number;
  losses: number;
  /** Points per game from the player's perspective, 0..1. */
  score: number;
  children: RepertoireNode[];
}

/** One tree per colour, because a repertoire is colour specific. */
export interface Repertoire {
  white: RepertoireNode;
  black: RepertoireNode;
}

export interface RepertoireOptions {
  /** How deep to follow a line. Defaults to the ply cap the phase model uses. */
  maxPly?: number;
  /** Drop lines played fewer times than this. Defaults to 1, which keeps everything. */
  minGames?: number;
  book?: OpeningBook;
}

/** A root-to-leaf line through a repertoire tree, flattened for display. */
export interface RepertoireLine {
  san: string[];
  ply: number;
  eco: string | null;
  name: string | null;
  inBook: boolean;
  games: number;
  wins: number;
  draws: number;
  losses: number;
  score: number;
}

/**
 * Expand a SAN line into the move rows the tree consumes, matching what ingest stores. Useful
 * for fixtures and for anything holding a PGN rather than a database row.
 */
export function movesFromSan(san: readonly string[]): RepertoireMove[] {
  const board = new Chess();
  return san.map((move, index) => {
    const fenBefore = board.fen();
    const played = board.move(move);
    return {
      ply: index + 1,
      san: played.san,
      uci: `${played.from}${played.to}${played.promotion ?? ''}`,
      fenBefore,
    };
  });
}

/**
 * The position key after a move.
 *
 * Almost always free: the next move's `fenBefore` is exactly it. Only a game's final move
 * needs replaying, which is one `chess.js` position per game rather than one per ply.
 */
export function keyAfter(move: RepertoireMove, next: RepertoireMove | undefined): string {
  if (next) return positionKey(next.fenBefore);
  const board = new Chess(move.fenBefore);
  board.move({
    from: move.uci.slice(0, 2),
    to: move.uci.slice(2, 4),
    promotion: move.uci.slice(4) || undefined,
  });
  return positionKey(board.fen());
}

interface MutableNode {
  key: string;
  move: { san: string; uci: string } | null;
  ply: number;
  eco: string | null;
  name: string | null;
  inBook: boolean;
  games: number;
  wins: number;
  draws: number;
  losses: number;
  children: Map<string, MutableNode>;
}

function emptyNode(key: string, ply: number, move: MutableNode['move']): MutableNode {
  return {
    key,
    move,
    ply,
    eco: null,
    name: null,
    inBook: ply === 0,
    games: 0,
    wins: 0,
    draws: 0,
    losses: 0,
    children: new Map(),
  };
}

function record(node: MutableNode, result: GameResult): void {
  node.games += 1;
  if (result === 'win') node.wins += 1;
  else if (result === 'draw') node.draws += 1;
  else node.losses += 1;
}

function freeze(node: MutableNode, minGames: number): RepertoireNode {
  const children = [...node.children.values()]
    .filter((child) => child.games >= minGames)
    .sort((a, b) => b.games - a.games || (a.move?.san ?? '').localeCompare(b.move?.san ?? ''))
    .map((child) => freeze(child, minGames));

  return {
    key: node.key,
    move: node.move,
    ply: node.ply,
    turn: node.ply % 2 === 0 ? 'w' : 'b',
    eco: node.eco,
    name: node.name,
    inBook: node.inBook,
    games: node.games,
    wins: node.wins,
    draws: node.draws,
    losses: node.losses,
    score: node.games === 0 ? 0 : (node.wins + node.draws / 2) / node.games,
    children,
  };
}

/**
 * Build one tree per colour from the player's games.
 *
 * A game contributes to every node on its path, so a node's counts are "games that reached
 * this position", which is what makes the score at a node mean something.
 */
export function buildRepertoire(
  games: Iterable<RepertoireGame>,
  options: RepertoireOptions = {},
): Repertoire {
  const book = options.book ?? defaultBook();
  const maxPly = options.maxPly ?? OPENING_MAX_PLY;
  const minGames = options.minGames ?? 1;
  const rootKey = positionKey(START_FEN);

  const roots: Record<Color, MutableNode> = {
    w: emptyNode(rootKey, 0, null),
    b: emptyNode(rootKey, 0, null),
  };

  for (const game of games) {
    const moves = game.moves.slice(0, maxPly);
    if (moves.length === 0) continue;

    const root = roots[game.color];
    record(root, game.result);

    let node = root;
    for (const [index, move] of moves.entries()) {
      let child = node.children.get(move.uci);
      if (!child) {
        const parentPosition = node.inBook ? book.get(node.key) : undefined;
        const stillTheory =
          parentPosition !== undefined &&
          parentPosition.moves.some((candidate) => candidate.uci === move.uci);

        // `next` comes from the unsliced game, so it is undefined only at the true end of a
        // game — the one place per game where keyAfter has to replay anything.
        const childKey = keyAfter(move, game.moves[index + 1]);
        child = emptyNode(childKey, index + 1, { san: move.san, uci: move.uci });
        child.inBook = stillTheory;
        const named = stillTheory ? book.get(childKey) : undefined;
        child.eco = named?.eco ?? node.eco;
        child.name = named?.name ?? node.name;
        node.children.set(move.uci, child);
      }

      record(child, game.result);
      node = child;
    }
  }

  return { white: freeze(roots.w, minGames), black: freeze(roots.b, minGames) };
}

/**
 * The player's most played complete lines, deepest form first.
 *
 * A "line" is a root-to-leaf path through the tree, so it ends where their games stopped
 * agreeing with each other or where `maxPly` cut them off.
 */
export function topLines(root: RepertoireNode, limit = 10): RepertoireLine[] {
  if (root.games === 0) return [];

  const lines: RepertoireLine[] = [];

  const walk = (node: RepertoireNode, san: string[]): void => {
    if (node.children.length === 0) {
      if (san.length === 0) return;
      lines.push({
        san,
        ply: node.ply,
        eco: node.eco,
        name: node.name,
        inBook: node.inBook,
        games: node.games,
        wins: node.wins,
        draws: node.draws,
        losses: node.losses,
        score: node.score,
      });
      return;
    }
    for (const child of node.children) walk(child, [...san, child.move?.san ?? '']);
  };

  walk(root, []);

  return lines
    .sort(
      (a, b) =>
        b.games - a.games || b.ply - a.ply || a.san.join(' ').localeCompare(b.san.join(' ')),
    )
    .slice(0, limit);
}
