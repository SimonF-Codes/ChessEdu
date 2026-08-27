/**
 * Splitting a game into phases, so strength can be modelled per phase rather than collapsed
 * into one rating. See the strength model in docs/architecture.md.
 */

export type Phase = 'opening' | 'middlegame' | 'endgame';

/** Non-pawn, non-king piece values used only for judging the phase. */
const PIECE_VALUES: Readonly<Record<string, number>> = {
  q: 9,
  r: 5,
  b: 3,
  n: 3,
};

/** Both armies intact. */
export const FULL_MATERIAL = 62;

/** At or below this, queens and most pieces are gone: it is an endgame however early it is. */
export const ENDGAME_MATERIAL = 20;

/** The opening cannot outlast this many plies whatever is still on the board. */
export const OPENING_MAX_PLY = 24;

/** Nor can it survive this much material coming off. */
export const OPENING_MIN_MATERIAL = 52;

/**
 * Total non-pawn material on the board, both colours, from the placement field of a FEN.
 * Kings and pawns are excluded — neither tells you anything about the phase.
 */
export function nonPawnMaterial(fen: string): number {
  const placement = fen.split(' ')[0] ?? '';
  let total = 0;
  for (const char of placement) {
    const value = PIECE_VALUES[char.toLowerCase()];
    if (value !== undefined) total += value;
  }
  return total;
}

/**
 * Which phase a position belongs to.
 *
 * Material is checked first: a queen trade on move 6 produces an endgame, and calling it an
 * opening because the ply count is low would put the coaching in the wrong book.
 */
export function phaseOf(fen: string, ply: number): Phase {
  const material = nonPawnMaterial(fen);
  if (material <= ENDGAME_MATERIAL) return 'endgame';
  if (ply <= OPENING_MAX_PLY && material >= OPENING_MIN_MATERIAL) return 'opening';
  return 'middlegame';
}
