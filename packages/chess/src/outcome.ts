import type { Chess } from 'chess.js';

import type { Color } from './classify';

/**
 * Reading the end of a game off a position.
 *
 * chess.js knows all of this; what it does not do is put it in one place with a result and a
 * sentence attached, and doing that in a React component would be exactly the mistake
 * CONTRIBUTING.md warns about. The engine is never consulted — whether a game is over is a
 * rule, not an evaluation.
 */

export type GameEnding =
  | 'checkmate'
  | 'stalemate'
  | 'insufficient-material'
  | 'threefold-repetition'
  | 'fifty-move'
  | 'draw';

export type GameResultScore = '1-0' | '0-1' | '1/2-1/2';

export interface Outcome {
  ending: GameEnding;
  score: GameResultScore;
  /** The winner, or null when the game was drawn. */
  winner: Color | null;
  /** One sentence, ready to show. */
  message: string;
}

const DRAW_MESSAGES: Record<Exclude<GameEnding, 'checkmate'>, string> = {
  stalemate: 'Stalemate — no legal move, and no check. Drawn.',
  'insufficient-material': 'Draw. Neither side has enough material to mate.',
  'threefold-repetition': 'Draw by threefold repetition.',
  'fifty-move': 'Draw by the fifty-move rule.',
  draw: 'Draw.',
};

function drawn(ending: Exclude<GameEnding, 'checkmate'>): Outcome {
  return { ending, score: '1/2-1/2', winner: null, message: DRAW_MESSAGES[ending] };
}

/**
 * How the game ended, or null while it is still going.
 *
 * The specific draws are checked before the general one because `isDraw()` is true for all of
 * them, and "drawn by the fifty-move rule" is worth more to a player than "drawn".
 */
export function outcomeOf(game: Chess): Outcome | null {
  if (!game.isGameOver()) return null;

  if (game.isCheckmate()) {
    // turn() is the side that has been mated.
    const winner: Color = game.turn() === 'w' ? 'b' : 'w';
    return {
      ending: 'checkmate',
      score: winner === 'w' ? '1-0' : '0-1',
      winner,
      message: `Checkmate — ${winner === 'w' ? 'White' : 'Black'} wins.`,
    };
  }

  if (game.isStalemate()) return drawn('stalemate');
  if (game.isInsufficientMaterial()) return drawn('insufficient-material');
  if (game.isThreefoldRepetition()) return drawn('threefold-repetition');
  if (game.isDrawByFiftyMoves()) return drawn('fifty-move');
  return drawn('draw');
}
