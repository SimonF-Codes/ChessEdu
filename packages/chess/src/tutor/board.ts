import type { Chess, Color, PieceSymbol, Square } from 'chess.js';

/**
 * Small, exact facts about a board that the detectors are built from: which squares a piece
 * attacks, who attacks a square, how much material each side has.
 *
 * Attacks are pseudo-legal — a pinned knight still "attacks" — because that is what a player
 * sees when they look at the board, and what "the knight attacks e5" means in a sentence.
 */

export const PIECE_VALUE: Record<PieceSymbol, number> = {
  p: 1,
  n: 3,
  b: 3,
  r: 5,
  q: 9,
  k: 0,
};

export const PIECE_NAME: Record<PieceSymbol, string> = {
  p: 'pawn',
  n: 'knight',
  b: 'bishop',
  r: 'rook',
  q: 'queen',
  k: 'king',
};

const FILES = 'abcdefgh';

function coords(square: Square): [file: number, rank: number] {
  return [FILES.indexOf(square[0]!), Number(square[1]) - 1];
}

function squareAt(file: number, rank: number): Square | null {
  if (file < 0 || file > 7 || rank < 0 || rank > 7) return null;
  return `${FILES[file]}${rank + 1}` as Square;
}

const KNIGHT_STEPS = [
  [1, 2],
  [2, 1],
  [2, -1],
  [1, -2],
  [-1, -2],
  [-2, -1],
  [-2, 1],
  [-1, 2],
] as const;

const KING_STEPS = [
  [1, 0],
  [1, 1],
  [0, 1],
  [-1, 1],
  [-1, 0],
  [-1, -1],
  [0, -1],
  [1, -1],
] as const;

const DIAGONALS = [
  [1, 1],
  [1, -1],
  [-1, 1],
  [-1, -1],
] as const;

const ORTHOGONALS = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
] as const;

/** The directions a slider moves in; empty for a piece that does not slide. */
export function rays(piece: PieceSymbol): readonly (readonly [number, number])[] {
  if (piece === 'b') return DIAGONALS;
  if (piece === 'r') return ORTHOGONALS;
  if (piece === 'q') return [...DIAGONALS, ...ORTHOGONALS];
  return [];
}

/** The squares, in order, from `from` along a direction to the first occupied square inclusive. */
export function walkRay(chess: Chess, from: Square, [df, dr]: readonly [number, number]): Square[] {
  const out: Square[] = [];
  let [file, rank] = coords(from);
  for (;;) {
    file += df;
    rank += dr;
    const square = squareAt(file, rank);
    if (!square) return out;
    out.push(square);
    if (chess.get(square)) return out;
  }
}

/** Every square the piece on `square` attacks. Empty if the square is empty. */
export function attackedBy(chess: Chess, square: Square): Square[] {
  const piece = chess.get(square);
  if (!piece) return [];
  const [file, rank] = coords(square);
  const steps = (list: readonly (readonly [number, number])[]) =>
    list.map(([df, dr]) => squareAt(file + df, rank + dr)).filter((s): s is Square => s !== null);

  switch (piece.type) {
    case 'p': {
      const forward = piece.color === 'w' ? 1 : -1;
      return steps([
        [-1, forward],
        [1, forward],
      ]);
    }
    case 'n':
      return steps(KNIGHT_STEPS);
    case 'k':
      return steps(KING_STEPS);
    default:
      return rays(piece.type).flatMap((direction) => walkRay(chess, square, direction));
  }
}

/** The squares of `color`'s pieces that attack `target`. */
export function attackersOf(chess: Chess, target: Square, color: Color): Square[] {
  const out: Square[] = [];
  for (const row of chess.board()) {
    for (const cell of row) {
      if (cell && cell.color === color && attackedBy(chess, cell.square).includes(target)) {
        out.push(cell.square);
      }
    }
  }
  return out;
}

/** Every piece of `color` on the board, with its square. */
export function piecesOf(
  chess: Chess,
  color: Color,
): { square: Square; type: PieceSymbol; color: Color }[] {
  return chess
    .board()
    .flat()
    .filter((cell): cell is NonNullable<typeof cell> => cell !== null && cell.color === color);
}

/** `color`'s material minus the opponent's, in pawns. Kings count nothing. */
export function materialBalance(chess: Chess, color: Color): number {
  let total = 0;
  for (const cell of chess.board().flat()) {
    if (!cell) continue;
    total += (cell.color === color ? 1 : -1) * PIECE_VALUE[cell.type];
  }
  return total;
}

/**
 * The enemy pawn a pawn standing on `square` is in contact with — one it attacks, which is also
 * one that attacks it, since pawns capture diagonally toward each other. Null if none.
 */
export function pawnContact(chess: Chess, square: Square, color: Color): Square | null {
  const [file, rank] = coords(square);
  const forward = color === 'w' ? 1 : -1;
  for (const df of [-1, 1]) {
    const target = squareAt(file + df, rank + forward);
    if (!target) continue;
    const piece = chess.get(target);
    if (piece && piece.type === 'p' && piece.color !== color) return target;
  }
  return null;
}

export const CENTRE: readonly Square[] = ['d4', 'e4', 'd5', 'e5'];

/** Where each minor piece starts, so a move from there is its first. */
export const MINOR_HOME: Record<Color, readonly Square[]> = {
  w: ['b1', 'g1', 'c1', 'f1'],
  b: ['b8', 'g8', 'c8', 'f8'],
};
