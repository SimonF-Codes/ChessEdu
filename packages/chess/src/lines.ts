import { Chess } from 'chess.js';

import { type OpeningBook, positionKey } from './book';

/**
 * Generating drillable opening lines: a tree walked from a fixed root, emitted leaf by leaf.
 *
 * Who picks each move is the whole design (docs/adr/0006-opening-line-drill.md):
 *
 * - inside the root, the opening's own definition — `3.c3` *is* the Ponziani, whatever an engine
 *   thinks of it;
 * - the learner's move, always the engine's best;
 * - the opponent's move, every book continuation for its first `branchDecisions` decisions, and
 *   the engine's best after that, or wherever the book has nothing.
 *
 * The engine is injected, so this stays pure and is tested with a scripted one. The book supplies
 * branches and names; it is never asked what is good. The model is not involved at all.
 */

type Color = 'w' | 'b';

/** Ten plies is where recall stops paying; one more so the line ends on the learner's move. */
export const LINE_DEPTH_PLIES = 11;

/** How many of the opponent's decisions after the root branch on the book. */
export const LINE_BRANCH_DECISIONS = 2;

/** Where a ply's move came from, stored with it so a line can be audited. */
export type LineMoveSource = 'opening' | 'book' | 'engine';

export interface LinePly {
  /** 1-based from the start position. */
  ply: number;
  color: Color;
  san: string;
  uci: string;
  fenBefore: string;
  source: LineMoveSource;
}

export interface LineSpec {
  /** Groups the lines one run produces, so the next run can retire what it no longer emits. */
  family: string;
  eco: string;
  /** The name to use when a line never reaches a named position deeper than the root. */
  name: string;
  rootSan: readonly string[];
  learnerColor: Color;
  depthPlies: number;
  branchDecisions: number;
}

export interface GeneratedLine {
  key: string;
  family: string;
  eco: string;
  name: string;
  learnerColor: Color;
  plies: LinePly[];
}

/** An engine's best move for a position, in UCI, or null when there is none. */
export type ChooseMove = (fen: string) => Promise<string | null>;

export const PONZIANI: LineSpec = {
  family: 'ponziani',
  eco: 'C44',
  name: 'Ponziani Opening',
  rootSan: ['e4', 'e5', 'Nf3', 'Nc6', 'c3'],
  learnerColor: 'w',
  depthPlies: LINE_DEPTH_PLIES,
  branchDecisions: LINE_BRANCH_DECISIONS,
};

/**
 * A line's identity: the learner's colour and its moves. Transpositions are deliberately not
 * folded together — a line is drilled from move one, so its move order is what is learnt.
 */
export function lineKey(learnerColor: Color, ucis: readonly string[]): string {
  return `${learnerColor}:${ucis.join(' ')}`;
}

function uciOf(move: { from: string; to: string; promotion?: string }): string {
  return `${move.from}${move.to}${move.promotion ?? ''}`;
}

/** The side to move after `plies` half-moves from the start position. */
function colorAt(plies: number): Color {
  return plies % 2 === 0 ? 'w' : 'b';
}

/**
 * Walk the tree and return every line, in a stable order: depth first, book branches in the
 * book's own order. Each distinct position is put to the engine once.
 */
export async function generateLines(
  spec: LineSpec,
  deps: { book: OpeningBook; chooseMove: ChooseMove },
): Promise<GeneratedLine[]> {
  if (colorAt(spec.depthPlies - 1) !== spec.learnerColor) {
    throw new Error(
      `a ${spec.depthPlies}-ply line would end on the opponent's move; lines end on the learner's`,
    );
  }

  // Validate the root up front: an illegal definition is a bug in the spec, not a short line.
  const probe = new Chess();
  for (const san of spec.rootSan) probe.move(san);

  const cache = new Map<string, Promise<string | null>>();
  const engineMove = (fen: string): Promise<string | null> => {
    const key = positionKey(fen);
    let pending = cache.get(key);
    if (!pending) {
      pending = deps.chooseMove(fen);
      cache.set(key, pending);
    }
    return pending;
  };

  const lines: GeneratedLine[] = [];
  const board = new Chess();
  const plies: LinePly[] = [];

  const push = (uci: string, source: LineMoveSource): void => {
    const fenBefore = board.fen();
    let move;
    try {
      move = board.move({
        from: uci.slice(0, 2),
        to: uci.slice(2, 4),
        promotion: uci.slice(4) || undefined,
      });
    } catch {
      throw new Error(`illegal move ${uci} from ${source} in ${fenBefore}`);
    }
    plies.push({
      ply: plies.length + 1,
      color: move.color,
      san: move.san,
      uci: uciOf(move),
      fenBefore,
      source,
    });
  };

  const pop = (): void => {
    board.undo();
    plies.pop();
  };

  const emit = (): void => {
    // A line ends on the learner's move; trim an opponent move left dangling by a game ending.
    let length = plies.length;
    while (length > 0 && plies[length - 1]!.color !== spec.learnerColor) length -= 1;
    const kept = plies.slice(0, length).map((p) => ({ ...p }));
    if (kept.length <= spec.rootSan.length) return;

    let eco = spec.eco;
    let name = spec.name;
    const walker = new Chess();
    for (const ply of kept) {
      walker.move(ply.san);
      const named = deps.book.get(walker.fen());
      if (named?.eco && named.name) {
        eco = named.eco;
        name = named.name;
      }
    }

    lines.push({
      key: lineKey(
        spec.learnerColor,
        kept.map((p) => p.uci),
      ),
      family: spec.family,
      eco,
      name,
      learnerColor: spec.learnerColor,
      plies: kept,
    });
  };

  const walk = async (opponentDecisions: number): Promise<void> => {
    if (plies.length >= spec.depthPlies || board.isGameOver()) {
      emit();
      return;
    }

    const index = plies.length;
    if (index < spec.rootSan.length) {
      const move = board.move(spec.rootSan[index]!);
      board.undo();
      push(uciOf(move), 'opening');
      await walk(opponentDecisions);
      pop();
      return;
    }

    const fen = board.fen();
    if (board.turn() === spec.learnerColor) {
      const uci = await engineMove(fen);
      if (!uci) return emit();
      push(uci, 'engine');
      await walk(opponentDecisions);
      pop();
      return;
    }

    const bookMoves = deps.book.get(fen)?.moves ?? [];
    if (opponentDecisions < spec.branchDecisions && bookMoves.length > 0) {
      for (const move of bookMoves) {
        push(move.uci, 'book');
        await walk(opponentDecisions + 1);
        pop();
      }
      return;
    }

    const uci = await engineMove(fen);
    if (!uci) return emit();
    push(uci, 'engine');
    await walk(opponentDecisions + 1);
    pop();
  };

  await walk(0);
  return lines;
}
