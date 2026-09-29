import type { TutorPly } from './types';

/**
 * The edge of what the tutor knows, drawn explicitly (docs/adr/0008-computed-tutor-and-learn-mode.md).
 *
 * The tutor knows the moves the stored lines play and nothing else. Asked about any other move it
 * says exactly `NOT_ANALYSED` — not a guess at why the move is weaker, not an evaluation, nothing a
 * reader could mistake for analysis. A bot that improvises cannot be told apart from one that
 * knows, so this answer is a code path with its own tests, not a fallback string.
 */

export const NOT_ANALYSED = 'I have not analysed that move.';

export interface StoredLineRef {
  id: string;
  name: string;
  plies: readonly TutorPly[];
}

/** Where a stored line plays a given move from a given position. */
export interface TreeEntry {
  lineId: string;
  lineName: string;
  /** Index into that line's plies. */
  index: number;
  ply: TutorPly;
}

/** Position -> move played from it -> every stored line that plays it there, in input order. */
export type LineTree = ReadonlyMap<string, ReadonlyMap<string, readonly TreeEntry[]>>;

/**
 * The position part of a FEN — pieces, side to move, castling, en passant — without the move
 * counters, so the same position reached by the same moves always matches.
 */
function positionOf(fen: string): string {
  return fen.split(' ').slice(0, 4).join(' ');
}

export function buildLineTree(lines: readonly StoredLineRef[]): LineTree {
  const tree = new Map<string, Map<string, TreeEntry[]>>();
  for (const line of lines) {
    line.plies.forEach((ply, index) => {
      const position = positionOf(ply.fenBefore);
      let moves = tree.get(position);
      if (!moves) tree.set(position, (moves = new Map()));
      let entries = moves.get(ply.uci);
      if (!entries) moves.set(ply.uci, (entries = []));
      entries.push({ lineId: line.id, lineName: line.name, index, ply });
    });
  }
  return tree;
}

/** How many different moves the stored lines play from this position. */
export function movesStoredAt(tree: LineTree, fen: string): number {
  return tree.get(positionOf(fen))?.size ?? 0;
}

export type MoveAnswer =
  /** The move this line plays here. */
  | { kind: 'this-line'; index: number }
  /** Not this line's move, but another stored line plays it from here. */
  | { kind: 'other-line'; lineId: string; lineName: string; index: number; ply: TutorPly }
  /** Outside every stored line. The only text the tutor may give is `NOT_ANALYSED`. */
  | { kind: 'not-analysed'; text: typeof NOT_ANALYSED };

/**
 * What the tutor can say about `uci` played from `fen`, while reading line `lineId`. Answers only
 * from the stored lines; anything they do not contain is `not-analysed`.
 */
export function askAboutMove(
  tree: LineTree,
  input: { lineId: string; fen: string; uci: string },
): MoveAnswer {
  const entries = tree.get(positionOf(input.fen))?.get(input.uci) ?? [];
  const own = entries.find((entry) => entry.lineId === input.lineId);
  if (own) return { kind: 'this-line', index: own.index };
  const [other] = entries;
  if (other) {
    return {
      kind: 'other-line',
      lineId: other.lineId,
      lineName: other.lineName,
      index: other.index,
      ply: other.ply,
    };
  }
  return { kind: 'not-analysed', text: NOT_ANALYSED };
}
