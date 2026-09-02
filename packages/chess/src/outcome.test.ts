import { Chess } from 'chess.js';
import { describe, expect, it } from 'vitest';

import { outcomeOf } from './outcome';

function played(...sans: string[]): Chess {
  const game = new Chess();
  for (const san of sans) game.move(san);
  return game;
}

describe('outcomeOf', () => {
  it('says nothing while the game is still going', () => {
    expect(outcomeOf(played('e4', 'e5'))).toBeNull();
  });

  it('names the winner of a checkmate', () => {
    // Fool's mate: White is mated, so Black wins.
    const outcome = outcomeOf(played('f3', 'e5', 'g4', 'Qh4#'));

    expect(outcome).toEqual({
      ending: 'checkmate',
      score: '0-1',
      winner: 'b',
      message: 'Checkmate — Black wins.',
    });
  });

  it('gets the other side of a checkmate right too', () => {
    // Scholar's mate.
    const outcome = outcomeOf(played('e4', 'e5', 'Bc4', 'Nc6', 'Qh5', 'Nf6', 'Qxf7#'));

    expect(outcome?.score).toBe('1-0');
    expect(outcome?.winner).toBe('w');
  });

  it('recognises stalemate', () => {
    const outcome = outcomeOf(new Chess('7k/5Q2/6K1/8/8/8/8/8 b - - 0 1'));

    expect(outcome?.ending).toBe('stalemate');
    expect(outcome?.score).toBe('1/2-1/2');
    expect(outcome?.winner).toBeNull();
  });

  it('recognises a position nobody can win', () => {
    expect(outcomeOf(new Chess('8/8/8/4k3/8/8/8/4K3 w - - 0 1'))?.ending).toBe(
      'insufficient-material',
    );
  });

  it('recognises threefold repetition', () => {
    const shuffle = played('Nf3', 'Nf6', 'Ng1', 'Ng8', 'Nf3', 'Nf6', 'Ng1', 'Ng8');

    expect(outcomeOf(shuffle)?.ending).toBe('threefold-repetition');
  });

  it('recognises the fifty-move rule, and names it rather than saying just "draw"', () => {
    const outcome = outcomeOf(new Chess('4k3/8/8/8/8/8/4P3/4K3 w - - 100 60'));

    expect(outcome?.ending).toBe('fifty-move');
    expect(outcome?.message).toBe('Draw by the fifty-move rule.');
  });
});
