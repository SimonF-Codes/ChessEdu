import { describe, expect, it } from 'vitest';

import { MIN_MOVES_PER_PHASE } from '@chessedu/chess';

import { type GameRow, summariseGames } from './strength';

/**
 * The database-backed part of this module is a plain scoped select; what is worth testing is
 * the fold: which side of each game counts, and what happens to a game the worker has not
 * analysed yet.
 */

const phases = (moves: number, accuracy: number) => ({
  opening: { moves, accuracy, averageCentipawnLoss: 20, blunders: 0 },
  middlegame: { moves, accuracy, averageCentipawnLoss: 40, blunders: 1 },
  endgame: { moves, accuracy, averageCentipawnLoss: 60, blunders: 0 },
});

const row = (over: Partial<GameRow> = {}): GameRow => ({
  id: 'game-1',
  url: 'https://www.chess.com/game/live/1',
  playedAt: new Date('2026-08-01T12:00:00Z'),
  userColor: 'w',
  userResult: 'win',
  opponentUsername: 'someone',
  opponentRating: 1420,
  eco: 'C50',
  accuracyWhite: 88,
  accuracyBlack: 61,
  phaseBreakdown: { white: phases(10, 88), black: phases(10, 61) },
  ...over,
});

describe('summariseGames', () => {
  it('is safe on an account with no games', () => {
    const dashboard = summariseGames([]);
    expect(dashboard.games).toBe(0);
    expect(dashboard.analysedGames).toBe(0);
    expect(dashboard.pendingGames).toBe(0);
    expect(dashboard.profile.focus).toBeNull();
    expect(dashboard.recent).toEqual([]);
  });

  it('builds the profile from the side the user actually played', () => {
    const dashboard = summariseGames([
      row({ userColor: 'b' }),
      row({ id: 'game-2', userColor: 'b' }),
    ]);

    // Black's numbers, not White's, however the game is stored.
    expect(dashboard.profile.phases.opening.accuracy).toBeCloseTo(61, 6);
    expect(dashboard.profile.phases.opening.moves).toBe(20);
  });

  it('counts a game the worker has not analysed as pending, not as a weakness', () => {
    const dashboard = summariseGames([
      row(),
      row({
        id: 'game-2',
        accuracyWhite: null,
        accuracyBlack: null,
        phaseBreakdown: null,
      }),
    ]);

    expect(dashboard.games).toBe(2);
    expect(dashboard.analysedGames).toBe(1);
    expect(dashboard.pendingGames).toBe(1);
    expect(dashboard.profile.games).toBe(1);
    expect(dashboard.profile.phases.opening.moves).toBe(10);
  });

  it('rates a phase once the window holds enough moves', () => {
    const games = Array.from({ length: MIN_MOVES_PER_PHASE / 10 }, (_, index) =>
      row({ id: `game-${index}` }),
    );
    const dashboard = summariseGames(games);

    expect(dashboard.profile.phases.opening.rated).toBe(true);
    expect(dashboard.profile.phases.opening.moves).toBe(MIN_MOVES_PER_PHASE);
  });

  it('shows the user own accuracy on each recent game, whichever colour they had', () => {
    const dashboard = summariseGames([row({ userColor: 'w' }), row({ id: 'g2', userColor: 'b' })]);
    expect(dashboard.recent[0]!.accuracy).toBe(88);
    expect(dashboard.recent[1]!.accuracy).toBe(61);
  });

  it('leaves accuracy null on a game that has not been analysed', () => {
    const dashboard = summariseGames([
      row({ accuracyWhite: null, accuracyBlack: null, phaseBreakdown: null }),
    ]);
    expect(dashboard.recent[0]!.accuracy).toBeNull();
  });

  it('lists only the most recent games, but profiles all of them', () => {
    const games = Array.from({ length: 25 }, (_, index) => row({ id: `game-${index}` }));
    const dashboard = summariseGames(games, 10);

    expect(dashboard.recent).toHaveLength(10);
    expect(dashboard.recent[0]!.id).toBe('game-0');
    expect(dashboard.profile.games).toBe(25);
  });
});
