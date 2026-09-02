import { describe, expect, it } from 'vitest';

import { buildBook } from './book';
import type { RepertoireGame } from './repertoire';
import { buildRepertoire, movesFromSan, topLines } from './repertoire';

import type { Color } from './classify';
import type { GameResult } from './pgn';

let counter = 0;

function game(color: Color, result: GameResult, san: string[]): RepertoireGame {
  counter += 1;
  return { id: `g${counter}`, color, result, moves: movesFromSan(san) };
}

/** Follow a tree down a SAN path, so assertions read like the line they are about. */
function walk(root: ReturnType<typeof buildRepertoire>['white'], ...san: string[]) {
  let node = root;
  for (const move of san) {
    const next = node.children.find((child) => child.move?.san === move);
    if (!next) throw new Error(`no child ${move} under ply ${node.ply}`);
    node = next;
  }
  return node;
}

describe('movesFromSan', () => {
  it('produces the same shape ingest stores: ply, colour, san, uci and the fen before', () => {
    const moves = movesFromSan(['e4', 'c5']);
    expect(moves).toEqual([
      {
        ply: 1,
        san: 'e4',
        uci: 'e2e4',
        fenBefore: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
      },
      {
        ply: 2,
        san: 'c5',
        uci: 'c7c5',
        fenBefore: 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1',
      },
    ]);
  });
});

describe('buildRepertoire', () => {
  it('keeps a separate tree per colour, because a repertoire is colour specific', () => {
    const repertoire = buildRepertoire([
      game('w', 'win', ['e4', 'c5']),
      game('b', 'loss', ['d4', 'Nf6']),
    ]);

    expect(repertoire.white.games).toBe(1);
    expect(repertoire.black.games).toBe(1);
    expect(walk(repertoire.white, 'e4').games).toBe(1);
    expect(repertoire.black.children.map((child) => child.move?.san)).toEqual(['d4']);
  });

  it('merges games that share a prefix and splits them where they diverge', () => {
    const repertoire = buildRepertoire([
      game('w', 'win', ['e4', 'c5', 'Nf3']),
      game('w', 'loss', ['e4', 'c5', 'd4']),
      game('w', 'draw', ['e4', 'e5']),
    ]);

    expect(walk(repertoire.white, 'e4').games).toBe(3);
    expect(walk(repertoire.white, 'e4', 'c5').games).toBe(2);
    expect(walk(repertoire.white, 'e4', 'c5').children).toHaveLength(2);
  });

  it('scores every node from the player perspective', () => {
    const repertoire = buildRepertoire([
      game('w', 'win', ['e4']),
      game('w', 'draw', ['e4']),
      game('w', 'loss', ['e4']),
      game('w', 'loss', ['e4']),
    ]);

    expect(walk(repertoire.white, 'e4')).toMatchObject({
      games: 4,
      wins: 1,
      draws: 1,
      losses: 2,
      score: 0.375,
    });
  });

  it('orders children by how often the line is played', () => {
    const repertoire = buildRepertoire([
      game('w', 'win', ['d4']),
      game('w', 'win', ['e4']),
      game('w', 'win', ['e4']),
    ]);

    expect(repertoire.white.children.map((child) => child.move?.san)).toEqual(['e4', 'd4']);
  });

  it('stops at maxPly, so the tree stays an opening tree', () => {
    const repertoire = buildRepertoire([game('w', 'win', ['e4', 'e5', 'Nf3', 'Nc6'])], {
      maxPly: 2,
    });

    expect(walk(repertoire.white, 'e4', 'e5').children).toEqual([]);
  });

  it('prunes lines played fewer times than minGames', () => {
    const repertoire = buildRepertoire(
      [
        game('w', 'win', ['e4', 'c5']),
        game('w', 'win', ['e4', 'c5']),
        game('w', 'win', ['e4', 'e5']),
      ],
      { minGames: 2 },
    );

    expect(walk(repertoire.white, 'e4').children.map((child) => child.move?.san)).toEqual(['c5']);
  });

  it('names nodes from the book, carrying the last name down an unnamed continuation', () => {
    const book = buildBook([{ eco: 'X01', name: 'Test Line', pgn: '1. a3 a6' }]);
    const repertoire = buildRepertoire([game('w', 'win', ['a3', 'a6', 'b3'])], { book });

    expect(walk(repertoire.white, 'a3')).toMatchObject({ eco: null, name: null, inBook: true });
    expect(walk(repertoire.white, 'a3', 'a6')).toMatchObject({
      eco: 'X01',
      name: 'Test Line',
      inBook: true,
    });
    expect(walk(repertoire.white, 'a3', 'a6', 'b3')).toMatchObject({
      eco: 'X01',
      name: 'Test Line',
      inBook: false,
    });
  });

  it('stays off book below a deviation, even where the line transposes back into theory', () => {
    const book = buildBook([
      { eco: 'X01', name: 'Test Line', pgn: '1. d4 d5' },
      { eco: 'X02', name: 'Other Line', pgn: '1. Nf3 Nf6 2. d4 d5' },
    ]);
    // 1... Nf6 is not theory after 1. d4 here, but 2. Nf3 transposes to a position the book
    // does know. The tree reports the player's line, and their line left theory at ply 2.
    const repertoire = buildRepertoire([game('w', 'win', ['d4', 'Nf6', 'Nf3'])], { book });

    expect(walk(repertoire.white, 'd4').inBook).toBe(true);
    expect(walk(repertoire.white, 'd4', 'Nf6').inBook).toBe(false);
    expect(walk(repertoire.white, 'd4', 'Nf6', 'Nf3').inBook).toBe(false);
  });

  it('ignores games with no moves', () => {
    const repertoire = buildRepertoire([game('w', 'win', [])]);
    expect(repertoire.white.games).toBe(0);
    expect(repertoire.white.children).toEqual([]);
  });
});

describe('topLines', () => {
  it('returns the most played complete lines first', () => {
    const repertoire = buildRepertoire([
      game('w', 'win', ['e4', 'c5']),
      game('w', 'loss', ['e4', 'c5']),
      game('w', 'draw', ['e4', 'e5']),
    ]);

    const lines = topLines(repertoire.white);
    expect(lines.map((line) => line.san.join(' '))).toEqual(['e4 c5', 'e4 e5']);
    expect(lines[0]).toMatchObject({ games: 2, wins: 1, losses: 1, score: 0.5 });
  });

  it('honours the limit', () => {
    const repertoire = buildRepertoire([
      game('w', 'win', ['e4']),
      game('w', 'win', ['d4']),
      game('w', 'win', ['c4']),
    ]);

    expect(topLines(repertoire.white, 2)).toHaveLength(2);
  });

  it('is empty for a player who has no games with that colour', () => {
    const repertoire = buildRepertoire([game('w', 'win', ['e4'])]);
    expect(topLines(repertoire.black)).toEqual([]);
  });
});
