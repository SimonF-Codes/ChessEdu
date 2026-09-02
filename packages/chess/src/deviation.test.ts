import { describe, expect, it } from 'vitest';

import { buildBook } from './book';
import { findDeviation, rankDeviations } from './deviation';
import { movesFromSan } from './repertoire';

import type { Color } from './classify';
import type { PlyAnalysis } from './deviation';
import type { GameResult } from './pgn';
import type { RepertoireGame } from './repertoire';

function game(id: string, color: Color, result: GameResult, san: string[]): RepertoireGame {
  return { id, color, result, moves: movesFromSan(san) };
}

function analysed(gameId: string, ply: number, centipawnLoss: number): PlyAnalysis {
  return {
    gameId,
    ply,
    centipawnLoss,
    winPercentLoss: centipawnLoss / 10,
    classification:
      centipawnLoss >= 100
        ? 'blunder'
        : centipawnLoss >= 50
          ? 'mistake'
          : centipawnLoss >= 20
            ? 'inaccuracy'
            : 'good',
    bestMoveUci: 'd5c4',
  };
}

/** A small book that stops early, so both kinds of deviation are reachable. */
const testBook = buildBook([
  { eco: 'X01', name: 'Test Line', pgn: '1. d4 d5 2. c4' },
  { eco: 'X02', name: 'Test Line: Accepted', pgn: '1. d4 d5 2. c4 dxc4' },
  { eco: 'X03', name: 'Test Line: Declined', pgn: '1. d4 d5 2. c4 e6' },
]);

describe('findDeviation', () => {
  it('returns nothing while the game is still following theory', () => {
    expect(findDeviation(game('g1', 'w', 'win', ['d4', 'd5', 'c4']), testBook)).toBeNull();
  });

  it('flags a novelty: theory had moves here and the player played another', () => {
    const deviation = findDeviation(game('g1', 'b', 'loss', ['d4', 'd5', 'c4', 'Nf6']), testBook);

    expect(deviation).toMatchObject({
      gameId: 'g1',
      kind: 'novelty',
      ply: 4,
      color: 'b',
      byPlayer: true,
      san: 'Nf6',
      uci: 'g8f6',
      line: ['d4', 'd5', 'c4'],
      eco: 'X01',
      name: 'Test Line',
    });
    expect(deviation?.bookMoves.map((move) => move.san).sort()).toEqual(['dxc4', 'e6']);
  });

  it('separates running out of book from choosing against it', () => {
    const deviation = findDeviation(
      game('g1', 'w', 'win', ['d4', 'd5', 'c4', 'e6', 'Nc3']),
      testBook,
    );

    expect(deviation).toMatchObject({ kind: 'out-of-book', ply: 5, name: 'Test Line: Declined' });
    expect(deviation?.bookMoves).toEqual([]);
  });

  it('reports whose move it was, so an opponent leaving theory is not blamed on the player', () => {
    const deviation = findDeviation(game('g1', 'w', 'win', ['d4', 'd5', 'c4', 'Nf6']), testBook);
    expect(deviation).toMatchObject({ color: 'b', byPlayer: false });
  });

  it('carries the deviating position, so callers can group by it', () => {
    const deviation = findDeviation(game('g1', 'b', 'loss', ['d4', 'd5', 'c4', 'Nf6']), testBook);

    expect(deviation).not.toBeNull();
    expect(deviation?.key).toBe(deviation?.fenBefore.split(' ').slice(0, 4).join(' '));
  });

  it('flags the very first move when it is not theory, and has no name to give it', () => {
    expect(findDeviation(game('g1', 'w', 'win', ['h4']), testBook)).toMatchObject({
      kind: 'novelty',
      ply: 1,
      eco: null,
      name: null,
    });
  });
});

describe('rankDeviations', () => {
  const games = [
    // Black, deviating themselves at ply 4.
    game('g1', 'b', 'loss', ['d4', 'd5', 'c4', 'Nf6']),
    game('g2', 'b', 'loss', ['d4', 'd5', 'c4', 'Nf6']),
    game('g3', 'b', 'draw', ['d4', 'd5', 'c4', 'Bf5']),
    // White, so the ply 4 deviation is the opponent's.
    game('g4', 'w', 'win', ['d4', 'd5', 'c4', 'Nf6']),
    // White, following theory until it simply runs out.
    game('g5', 'w', 'win', ['d4', 'd5', 'c4', 'e6', 'Nc3']),
  ];

  const analysis = [analysed('g1', 4, 100), analysed('g2', 4, 60), analysed('g3', 4, 20)];

  it('groups repeated deviations by the position they leave', () => {
    const ranked = rankDeviations(games, { book: testBook, analysis });

    expect(ranked).toHaveLength(1);
    expect(ranked[0]).toMatchObject({
      games: 3,
      wins: 0,
      draws: 1,
      losses: 2,
      ply: 3,
      line: ['d4', 'd5', 'c4'],
      eco: 'X01',
      name: 'Test Line',
    });
    expect(ranked[0]?.score).toBeCloseTo(1 / 6);
  });

  it('shows what theory plays there, so there is something to learn', () => {
    const ranked = rankDeviations(games, { book: testBook, analysis });
    expect(ranked[0]?.bookMoves.map((move) => move.san).sort()).toEqual(['dxc4', 'e6']);
  });

  it('lists what was played instead, most frequent first', () => {
    const ranked = rankDeviations(games, { book: testBook, analysis });
    expect(ranked[0]?.played).toEqual([
      { san: 'Nf6', uci: 'g8f6', games: 2 },
      { san: 'Bf5', uci: 'c8f5', games: 1 },
    ]);
  });

  it('reads the cost from the engine and never decides it itself', () => {
    const ranked = rankDeviations(games, { book: testBook, analysis });

    expect(ranked[0]?.avgCentipawnLoss).toBe(60);
    expect(ranked[0]?.worstClassification).toBe('blunder');
    expect(ranked[0]?.cost).toBe(180);
  });

  it('leaves the cost unknown rather than guessing when the games are unanalysed', () => {
    const ranked = rankDeviations(games, { book: testBook });

    expect(ranked[0]?.avgCentipawnLoss).toBeNull();
    expect(ranked[0]?.worstClassification).toBeNull();
    expect(ranked[0]?.cost).toBe(0);
  });

  it("counts only the player's own deviations by default", () => {
    const ranked = rankDeviations(games, { book: testBook, analysis });
    expect(ranked.flatMap((entry) => entry.gameIds)).toEqual(['g1', 'g2', 'g3']);
  });

  it('can be asked for the deviations the player faces instead', () => {
    const ranked = rankDeviations(games, { book: testBook, by: 'opponent' });
    expect(ranked.flatMap((entry) => entry.gameIds)).toEqual(['g4']);
  });

  it('drops out-of-book endings, which teach nothing', () => {
    const ranked = rankDeviations([games[4]!], { book: testBook, by: 'either' });
    expect(ranked).toEqual([]);
  });

  describe('ranking', () => {
    const deepBook = buildBook([
      { eco: 'X01', name: 'Test Line', pgn: '1. d4 d5 2. c4' },
      { eco: 'X02', name: 'Test Line: Accepted', pgn: '1. d4 d5 2. c4 dxc4' },
      { eco: 'X04', name: 'Test Line: Baltic', pgn: '1. d4 d5 2. c4 Bf5' },
      { eco: 'X05', name: 'Test Line: Baltic, Main', pgn: '1. d4 d5 2. c4 Bf5 3. Nc3 e6' },
    ]);

    const habits = [
      game('c1', 'b', 'draw', ['d4', 'd5', 'c4', 'Bf5', 'Nc3', 'Nf6']),
      game('c2', 'b', 'draw', ['d4', 'd5', 'c4', 'Bf5', 'Nc3', 'Nf6']),
      game('e1', 'b', 'loss', ['d4', 'd5', 'c4', 'Nf6']),
    ];

    const habitAnalysis = [analysed('c1', 6, 10), analysed('c2', 6, 10), analysed('e1', 4, 300)];

    it('puts the habit that costs most first, frequency times average loss', () => {
      const ranked = rankDeviations(habits, { book: deepBook, analysis: habitAnalysis });
      expect(ranked.map((entry) => entry.cost)).toEqual([300, 20]);
      expect(ranked.map((entry) => entry.ply)).toEqual([3, 5]);
    });

    it('honours the limit', () => {
      const ranked = rankDeviations(habits, {
        book: deepBook,
        analysis: habitAnalysis,
        limit: 1,
      });
      expect(ranked).toHaveLength(1);
      expect(ranked[0]?.cost).toBe(300);
    });
  });
});
