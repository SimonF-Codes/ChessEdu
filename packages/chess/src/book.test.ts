import { Chess } from 'chess.js';
import { describe, expect, it } from 'vitest';

import { START_FEN, buildBook, defaultBook, parseEcoTsv, positionKey } from './book';

/** The position key reached by playing a SAN line from the start. */
function keyAfter(...san: string[]): string {
  const board = new Chess();
  for (const move of san) board.move(move);
  return positionKey(board.fen());
}

/** The FEN reached by playing a SAN line from the start. */
function fenAfter(...san: string[]): string {
  const board = new Chess();
  for (const move of san) board.move(move);
  return board.fen();
}

describe('positionKey', () => {
  it('keeps placement, side to move, castling and en passant', () => {
    expect(positionKey(START_FEN)).toBe(
      'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq -',
    );
  });

  it('ignores the move counters, so the same position matches whenever it arises', () => {
    const early = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
    const late = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 7 42';
    expect(positionKey(early)).toBe(positionKey(late));
  });
});

describe('parseEcoTsv', () => {
  it('reads eco, name and line from tab separated rows', () => {
    const entries = parseEcoTsv('B20\tSicilian Defense\t1. e4 c5\nB10\tCaro-Kann Defense\t1. e4 c6');
    expect(entries).toEqual([
      { eco: 'B20', name: 'Sicilian Defense', pgn: '1. e4 c5' },
      { eco: 'B10', name: 'Caro-Kann Defense', pgn: '1. e4 c6' },
    ]);
  });

  it('skips the header row and blank lines', () => {
    const entries = parseEcoTsv('eco\tname\tpgn\n\nB20\tSicilian Defense\t1. e4 c5\n\n');
    expect(entries).toHaveLength(1);
    expect(entries[0]?.eco).toBe('B20');
  });
});

describe('buildBook', () => {
  it('indexes every position along a line, not just the last one', () => {
    const book = buildBook([{ eco: 'X01', name: 'Test Line', pgn: '1. a3 a6 2. b3' }]);

    expect(book.has(fenAfter('a3'))).toBe(true);
    expect(book.has(fenAfter('a3', 'a6'))).toBe(true);
    expect(book.has(fenAfter('a3', 'a6', 'b3'))).toBe(true);
    expect(book.has(fenAfter('h3'))).toBe(false);
  });

  it('names only the position a line actually ends on', () => {
    const book = buildBook([{ eco: 'X01', name: 'Test Line', pgn: '1. a3 a6 2. b3' }]);

    expect(book.get(fenAfter('a3'))?.name).toBeNull();
    expect(book.get(fenAfter('a3', 'a6', 'b3'))).toMatchObject({
      eco: 'X01',
      name: 'Test Line',
      ply: 3,
    });
  });

  it('lists the theory continuations from a position', () => {
    const book = buildBook([
      { eco: 'X01', name: 'Test Line', pgn: '1. a3 a6' },
      { eco: 'X02', name: 'Other Line', pgn: '1. a3 h6' },
    ]);

    const moves = book.get(fenAfter('a3'))?.moves ?? [];
    expect(moves.map((move) => move.uci).sort()).toEqual(['a7a6', 'h7h6']);
    expect(moves.find((move) => move.uci === 'h7h6')?.name).toBe('Other Line');
  });

  it('leaves the end of a line with no continuations', () => {
    const book = buildBook([{ eco: 'X01', name: 'Test Line', pgn: '1. a3 a6' }]);
    expect(book.get(fenAfter('a3', 'a6'))?.moves).toEqual([]);
  });

  it('does not depend on the order entries arrive in', () => {
    const entries = [
      { eco: 'X01', name: 'Short Way', pgn: '1. d4 d5' },
      { eco: 'X02', name: 'Long Way Round', pgn: '1. Nf3 Nf6 2. Ng1 Ng8 3. d4 d5' },
      { eco: 'X03', name: 'Sideline', pgn: '1. d4 d5 2. c4' },
    ];
    // Lines are sorted internally so a shared prefix is replayed once. That is a cost
    // optimisation and must stay invisible in the result.
    const forwards = buildBook(entries);
    const backwards = buildBook([...entries].reverse());

    expect(backwards.size).toBe(forwards.size);
    for (const line of [['d4'], ['d4', 'd5'], ['d4', 'd5', 'c4'], ['Nf3', 'Nf6']]) {
      expect(backwards.get(fenAfter(...line))).toEqual(forwards.get(fenAfter(...line)));
    }
  });

  it('recognises a transposition, because the index is keyed by position', () => {
    const book = buildBook([{ eco: 'X01', name: 'Test Line', pgn: '1. d4 d5 2. Nf3' }]);

    // The same position by a different move order.
    expect(keyAfter('Nf3', 'd5', 'd4')).toBe(keyAfter('d4', 'd5', 'Nf3'));
    expect(book.get(fenAfter('Nf3', 'd5', 'd4'))?.name).toBe('Test Line');
  });

  it('prefers the shortest line when two entries reach the same position', () => {
    const book = buildBook([
      // Six plies of shuffling to the position the next entry reaches in two.
      { eco: 'X02', name: 'Long Way Round', pgn: '1. Nf3 Nf6 2. Ng1 Ng8 3. d4 d5' },
      { eco: 'X01', name: 'Short Way', pgn: '1. d4 d5' },
    ]);

    expect(book.get(fenAfter('d4', 'd5'))).toMatchObject({
      eco: 'X01',
      name: 'Short Way',
      ply: 2,
    });
  });
});

describe('defaultBook', () => {
  it('is memoised, so the replay cost is paid once per process', () => {
    expect(defaultBook()).toBe(defaultBook());
  });

  it('covers the whole vendored data set', () => {
    expect(defaultBook().size).toBeGreaterThan(3000);
  });

  it('knows the starting position and its first moves', () => {
    const start = defaultBook().get(START_FEN);
    expect(start?.ply).toBe(0);
    expect(start?.moves.map((move) => move.uci)).toContain('e2e4');
  });

  it('names the Ruy Lopez', () => {
    expect(defaultBook().get(fenAfter('e4', 'e5', 'Nf3', 'Nc6', 'Bb5'))).toMatchObject({
      eco: 'C60',
      name: 'Ruy Lopez',
      ply: 5,
    });
  });

  it('offers theory replies to the Ruy Lopez, and does not invent others', () => {
    const moves = defaultBook().get(fenAfter('e4', 'e5', 'Nf3', 'Nc6', 'Bb5'))?.moves ?? [];
    const byUci = new Map(moves.map((move) => [move.uci, move]));

    expect(byUci.get('a7a6')).toMatchObject({ san: 'a6', name: 'Ruy Lopez: Morphy Defense' });
    expect(byUci.get('g8f6')).toMatchObject({ san: 'Nf6', name: 'Ruy Lopez: Berlin Defense' });
    expect(byUci.has('h7h6')).toBe(false);
  });

  it('does not know a position that is not theory', () => {
    expect(defaultBook().get(fenAfter('a3', 'h6', 'h3', 'a6'))).toBeUndefined();
  });
});
