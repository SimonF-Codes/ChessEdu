import { describe, expect, it } from 'vitest';

import { parseBestMove, parseInfoLine, toWhitePerspective } from './uci';

describe('parseInfoLine', () => {
  const LINE =
    'info depth 20 seldepth 28 multipv 1 score cp 34 nodes 1234567 nps 900000 hashfull 200 tbhits 0 time 1370 pv e2e4 e7e5 g1f3 b8c6';

  it('reads the depth', () => {
    expect(parseInfoLine(LINE)?.depth).toBe(20);
  });

  it('reads a centipawn score', () => {
    expect(parseInfoLine(LINE)?.scoreCp).toBe(34);
  });

  it('reads the principal variation', () => {
    expect(parseInfoLine(LINE)?.pv).toEqual(['e2e4', 'e7e5', 'g1f3', 'b8c6']);
  });

  it('reads a mate score and leaves the centipawn score empty', () => {
    const info = parseInfoLine('info depth 15 score mate 3 pv d1h5 g6h5');
    expect(info?.mateIn).toBe(3);
    expect(info?.scoreCp).toBeNull();
  });

  it('reads a negative mate score', () => {
    expect(parseInfoLine('info depth 15 score mate -2 pv a1a2')?.mateIn).toBe(-2);
  });

  it('ignores lower bound and upper bound lines, which are not final scores', () => {
    expect(parseInfoLine('info depth 12 score cp 40 lowerbound nodes 1 pv e2e4')).toBeNull();
    expect(parseInfoLine('info depth 12 score cp 40 upperbound nodes 1 pv e2e4')).toBeNull();
  });

  it('ignores the currmove chatter engines emit while thinking', () => {
    expect(parseInfoLine('info depth 1 currmove e2e4 currmovenumber 1')).toBeNull();
  });

  it('ignores anything that is not an info line', () => {
    expect(parseInfoLine('readyok')).toBeNull();
    expect(parseInfoLine('')).toBeNull();
  });
});

describe('parseBestMove', () => {
  it('reads the move', () => {
    expect(parseBestMove('bestmove e2e4 ponder e7e5')).toBe('e2e4');
  });

  it('reads a move with no ponder', () => {
    expect(parseBestMove('bestmove g1f3')).toBe('g1f3');
  });

  it('returns null when the engine has no move', () => {
    expect(parseBestMove('bestmove (none)')).toBeNull();
  });

  it('ignores other lines', () => {
    expect(parseBestMove('info depth 3 score cp 12')).toBeNull();
  });
});

describe('toWhitePerspective', () => {
  it('leaves a score alone when White is to move', () => {
    expect(toWhitePerspective({ scoreCp: 120, mateIn: null }, 'w')).toEqual({
      cp: 120,
      mateIn: null,
    });
  });

  it('flips a score when Black is to move, since UCI is side-to-move relative', () => {
    expect(toWhitePerspective({ scoreCp: 120, mateIn: null }, 'b')).toEqual({
      cp: -120,
      mateIn: null,
    });
  });

  it('flips a mate score too', () => {
    expect(toWhitePerspective({ scoreCp: null, mateIn: 3 }, 'b')).toEqual({
      cp: null,
      mateIn: -3,
    });
  });

  it('does not turn a zero into a negative zero', () => {
    expect(Object.is(toWhitePerspective({ scoreCp: 0, mateIn: null }, 'b').cp, -0)).toBe(false);
  });
});
