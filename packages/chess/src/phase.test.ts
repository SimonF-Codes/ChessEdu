import { describe, expect, it } from 'vitest';

import { nonPawnMaterial, phaseOf } from './phase';

const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const ITALIAN = 'r1bqkbnr/pppp1ppp/2n5/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R b KQkq - 4 4';
const QUEENLESS_MIDDLEGAME = 'r3k2r/ppp2ppp/2n5/4p3/2B1P3/5N2/PPP2PPP/R3K2R w KQkq - 0 12';
const ROOK_ENDGAME = '8/5pk1/6p1/8/8/6P1/5PK1/R6r w - - 0 40';
const PAWN_ENDGAME = '8/5pk1/6p1/8/8/6P1/5PK1/8 w - - 0 55';

describe('nonPawnMaterial', () => {
  it('counts a full army at the start', () => {
    // Two sides of Q(9) + 2R(10) + 2B(6) + 2N(6) = 31 each.
    expect(nonPawnMaterial(START)).toBe(62);
  });

  it('ignores pawns and kings', () => {
    expect(nonPawnMaterial(PAWN_ENDGAME)).toBe(0);
  });

  it('counts a rook ending correctly', () => {
    expect(nonPawnMaterial(ROOK_ENDGAME)).toBe(10);
  });
});

describe('phaseOf', () => {
  it('calls the start of the game the opening', () => {
    expect(phaseOf(START, 1)).toBe('opening');
  });

  it('still calls a developed but intact position the opening', () => {
    expect(phaseOf(ITALIAN, 8)).toBe('opening');
  });

  it('leaves the opening once enough moves have been played, even with pieces on', () => {
    expect(phaseOf(START, 40)).toBe('middlegame');
  });

  it('calls a position with queens traded and pieces off the middlegame', () => {
    expect(phaseOf(QUEENLESS_MIDDLEGAME, 23)).toBe('middlegame');
  });

  it('calls a rook ending the endgame', () => {
    expect(phaseOf(ROOK_ENDGAME, 79)).toBe('endgame');
  });

  it('calls a pawn ending the endgame', () => {
    expect(phaseOf(PAWN_ENDGAME, 109)).toBe('endgame');
  });

  it('recognises an early endgame reached by a queen trade, regardless of ply', () => {
    expect(phaseOf(PAWN_ENDGAME, 12)).toBe('endgame');
  });
});
