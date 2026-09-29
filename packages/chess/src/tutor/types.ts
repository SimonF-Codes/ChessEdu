import type { Chess, Move } from 'chess.js';

import type { LineMoveSource, PlyFacts } from '../lines';

/**
 * The shapes the tutor speaks in. See docs/adr/0008-computed-tutor-and-learn-mode.md.
 *
 * Type-only imports from lines.ts, so nothing here pulls in the vendored ECO book: the tutor is
 * safe to bundle for the browser.
 */

/** One ply of a stored line, as the tutor reads it. `facts` is absent on lines stored before ADR 0008. */
export interface TutorPly {
  ply: number;
  color: 'w' | 'b';
  san: string;
  uci: string;
  fenBefore: string;
  source: LineMoveSource;
  facts?: PlyFacts | null;
}

/** A line as the tutor reads it. */
export interface TutorLine {
  family: string;
  learnerColor: 'w' | 'b';
  plies: readonly TutorPly[];
}

/**
 * Everything a detector may look at. Detectors must treat it as read-only: `before` and `after`
 * are shared between every detector run on the same move.
 */
export interface MoveContext {
  /** The position before the move. */
  before: Chess;
  /** The position after it. */
  after: Chess;
  move: Move;
  /** The move played just before this one, if the line has one — what "recaptures" needs. */
  previous: Move | null;
  /** The stored engine facts; null on the root and on lines stored before ADR 0008. */
  facts: PlyFacts | null;
  /** The plies of the line after this one. */
  rest: readonly TutorPly[];
}

/** One thing that is true about a move, said in a clause. */
export interface Motif {
  /** Stable, for tests and for suppressing one motif by another: `develops`, `only-move`, … */
  id: string;
  /** How much it is worth saying. The explanation keeps the heaviest few. */
  weight: number;
  /** The clause, lower-case, no full stop: `develops the knight to f3`. */
  text: string;
}

/**
 * A detector either fires with a motif or returns null. Pure and synchronous. One that cannot
 * substantiate its claim — no stored facts, no such piece — returns null; it never assumes.
 */
export type Detector = (ctx: MoveContext) => Motif | null;
