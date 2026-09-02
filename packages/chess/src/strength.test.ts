import { describe, expect, it } from 'vitest';

import { gameAccuracy } from './classify';
import type { Phase } from './phase';
import {
  MIN_MOVES_PER_PHASE,
  type PhaseBreakdown,
  type PhaseSample,
  buildStrengthProfile,
  combinePhaseSamples,
  emptyPhaseBreakdown,
  phaseBreakdownFor,
  practiceWeights,
} from './strength';

const sample = (over: Partial<PhaseSample> = {}): PhaseSample => ({
  moves: 0,
  accuracy: null,
  averageCentipawnLoss: 0,
  blunders: 0,
  ...over,
});

/** A breakdown with the given phases filled in and the rest empty. */
const breakdown = (phases: Partial<Record<Phase, Partial<PhaseSample>>>): PhaseBreakdown => {
  const result = emptyPhaseBreakdown();
  for (const [phase, values] of Object.entries(phases)) {
    result[phase as Phase] = sample(values);
  }
  return result;
};

/** Enough moves in every phase to clear the rating gate. */
const RATED = MIN_MOVES_PER_PHASE;

describe('combinePhaseSamples', () => {
  it('is an empty sample when there is nothing to combine', () => {
    expect(combinePhaseSamples([])).toEqual(sample());
  });

  it('sums moves and blunders', () => {
    const combined = combinePhaseSamples([
      sample({ moves: 10, accuracy: 90, blunders: 1 }),
      sample({ moves: 6, accuracy: 90, blunders: 2 }),
    ]);
    expect(combined.moves).toBe(16);
    expect(combined.blunders).toBe(3);
  });

  it('weights centipawn loss by moves rather than averaging the averages', () => {
    const combined = combinePhaseSamples([
      sample({ moves: 30, accuracy: 90, averageCentipawnLoss: 10 }),
      sample({ moves: 10, accuracy: 90, averageCentipawnLoss: 50 }),
    ]);
    // (30*10 + 10*50) / 40 = 20, not (10 + 50) / 2 = 30.
    expect(combined.averageCentipawnLoss).toBe(20);
  });

  it('ignores phases a game never reached', () => {
    const combined = combinePhaseSamples([
      sample({ moves: 12, accuracy: 80, averageCentipawnLoss: 40, blunders: 1 }),
      sample(),
    ]);
    expect(combined.moves).toBe(12);
    expect(combined.accuracy).toBeCloseTo(80, 6);
    expect(combined.averageCentipawnLoss).toBe(40);
  });

  it('has no accuracy when no game reached the phase', () => {
    expect(combinePhaseSamples([sample(), sample()]).accuracy).toBeNull();
  });

  it('recombines accuracy exactly, matching a single pass over every move', () => {
    // Two games' worth of per-move losses in one phase.
    const first = [0, 2, 4, 30];
    const second = [1, 1, 55];

    const combined = combinePhaseSamples([
      sample({ moves: first.length, accuracy: gameAccuracy(first) }),
      sample({ moves: second.length, accuracy: gameAccuracy(second) }),
    ]);

    expect(combined.accuracy).toBeCloseTo(gameAccuracy([...first, ...second])!, 6);
  });

  it('is dragged down by a disaster rather than averaging it away', () => {
    const good = sample({ moves: 40, accuracy: 95 });
    const awful = sample({ moves: 40, accuracy: 20 });
    const combined = combinePhaseSamples([good, awful]);
    // The harmonic mean sits below the arithmetic 57.5.
    expect(combined.accuracy!).toBeLessThan(40);
  });
});

describe('phaseBreakdownFor', () => {
  const stored = {
    white: {
      opening: { moves: 12, accuracy: 91.5, averageCentipawnLoss: 14, blunders: 0 },
      middlegame: { moves: 20, accuracy: 70, averageCentipawnLoss: 60, blunders: 2 },
      endgame: { moves: 0, accuracy: null, averageCentipawnLoss: 0, blunders: 0 },
    },
    black: {
      opening: { moves: 12, accuracy: 80, averageCentipawnLoss: 30, blunders: 1 },
      middlegame: { moves: 19, accuracy: 65, averageCentipawnLoss: 70, blunders: 3 },
      endgame: { moves: 0, accuracy: null, averageCentipawnLoss: 0, blunders: 0 },
    },
  };

  it('reads the side that was asked for', () => {
    expect(phaseBreakdownFor(stored, 'w')!.opening.accuracy).toBe(91.5);
    expect(phaseBreakdownFor(stored, 'b')!.opening.accuracy).toBe(80);
  });

  it('is null for a game that has not been analysed', () => {
    expect(phaseBreakdownFor(null, 'w')).toBeNull();
    expect(phaseBreakdownFor(undefined, 'w')).toBeNull();
  });

  it('is null for a column that holds something else entirely', () => {
    expect(phaseBreakdownFor('not json', 'w')).toBeNull();
    expect(phaseBreakdownFor({ white: 7 }, 'w')).toBeNull();
    expect(phaseBreakdownFor({ black: stored.black }, 'w')).toBeNull();
  });

  it('fills in a phase an older row is missing rather than dropping the game', () => {
    const partial = { white: { opening: { moves: 8, accuracy: 88 } } };
    const result = phaseBreakdownFor(partial, 'w')!;
    expect(result.opening.moves).toBe(8);
    expect(result.opening.accuracy).toBe(88);
    expect(result.opening.averageCentipawnLoss).toBe(0);
    expect(result.endgame).toEqual(sample());
  });

  it('rejects a sample whose move count is not a usable number', () => {
    expect(phaseBreakdownFor({ white: { opening: { moves: 'lots' } } }, 'w')).toBeNull();
  });
});

describe('buildStrengthProfile', () => {
  it('is empty and unrated for a player with no analysed games', () => {
    const profile = buildStrengthProfile([]);
    expect(profile.games).toBe(0);
    expect(profile.moves).toBe(0);
    expect(profile.focus).toBeNull();
    expect(profile.strongest).toBeNull();
    expect(profile.phases.opening.rated).toBe(false);
    expect(profile.phases.opening.accuracy).toBeNull();
    expect(profile.phases.opening.deficit).toBeNull();
  });

  it('counts games, moves, and the games that reached each phase', () => {
    const profile = buildStrengthProfile([
      breakdown({ opening: { moves: 10, accuracy: 90 }, middlegame: { moves: 20, accuracy: 80 } }),
      breakdown({ opening: { moves: 12, accuracy: 90 } }),
    ]);

    expect(profile.games).toBe(2);
    expect(profile.moves).toBe(42);
    expect(profile.phases.opening.games).toBe(2);
    expect(profile.phases.middlegame.games).toBe(1);
    expect(profile.phases.endgame.games).toBe(0);
  });

  it('reports blunders per hundred moves, not a raw count that grows with history', () => {
    const profile = buildStrengthProfile([
      breakdown({ middlegame: { moves: 200, accuracy: 70, blunders: 6 } }),
    ]);
    expect(profile.phases.middlegame.blundersPerHundredMoves).toBeCloseTo(3, 6);
  });

  it('leaves a phase unrated until it has enough moves to mean anything', () => {
    const profile = buildStrengthProfile([
      breakdown({ opening: { moves: MIN_MOVES_PER_PHASE - 1, accuracy: 40 } }),
    ]);
    expect(profile.phases.opening.rated).toBe(false);
    expect(profile.phases.opening.accuracy).toBeCloseTo(40, 6);
    expect(profile.focus).toBeNull();
    expect(profile.strongest).toBeNull();
  });

  it('rates a phase once the move threshold is reached', () => {
    const profile = buildStrengthProfile([
      breakdown({ opening: { moves: MIN_MOVES_PER_PHASE, accuracy: 40 } }),
    ]);
    expect(profile.phases.opening.rated).toBe(true);
    expect(profile.focus).toBe('opening');
    expect(profile.strongest).toBe('opening');
  });

  it('picks the weakest and strongest rated phase', () => {
    const profile = buildStrengthProfile([
      breakdown({
        opening: { moves: RATED, accuracy: 92 },
        middlegame: { moves: RATED, accuracy: 74 },
        endgame: { moves: RATED, accuracy: 61 },
      }),
    ]);

    expect(profile.focus).toBe('endgame');
    expect(profile.strongest).toBe('opening');
  });

  it('never lets an unrated phase become the focus', () => {
    const profile = buildStrengthProfile([
      breakdown({
        opening: { moves: RATED, accuracy: 92 },
        middlegame: { moves: RATED, accuracy: 74 },
        endgame: { moves: 3, accuracy: 10 },
      }),
    ]);

    expect(profile.focus).toBe('middlegame');
    expect(profile.phases.endgame.rated).toBe(false);
    expect(profile.phases.endgame.deficit).toBeNull();
  });

  it('measures deficit against the player own best phase', () => {
    const profile = buildStrengthProfile([
      breakdown({
        opening: { moves: RATED, accuracy: 90 },
        middlegame: { moves: RATED, accuracy: 72 },
      }),
    ]);

    expect(profile.phases.opening.deficit).toBeCloseTo(0, 6);
    expect(profile.phases.middlegame.deficit).toBeCloseTo(18, 6);
  });

  it('accumulates a phase across many games', () => {
    const games = Array.from({ length: 10 }, () =>
      breakdown({ endgame: { moves: 20, accuracy: 55, averageCentipawnLoss: 80, blunders: 1 } }),
    );
    const profile = buildStrengthProfile(games);

    expect(profile.phases.endgame.moves).toBe(200);
    expect(profile.phases.endgame.blunders).toBe(10);
    expect(profile.phases.endgame.accuracy).toBeCloseTo(55, 6);
    expect(profile.phases.endgame.averageCentipawnLoss).toBe(80);
    expect(profile.phases.endgame.rated).toBe(true);
  });
});

describe('practiceWeights', () => {
  it('splits practice evenly when nothing is rated yet', () => {
    const weights = practiceWeights(buildStrengthProfile([]));
    expect(weights.opening).toBeCloseTo(1 / 3, 6);
    expect(weights.middlegame).toBeCloseTo(1 / 3, 6);
    expect(weights.endgame).toBeCloseTo(1 / 3, 6);
  });

  it('always sums to one', () => {
    const weights = practiceWeights(
      buildStrengthProfile([
        breakdown({
          opening: { moves: RATED, accuracy: 95 },
          middlegame: { moves: RATED, accuracy: 70 },
          endgame: { moves: 4, accuracy: 30 },
        }),
      ]),
    );
    const total = weights.opening + weights.middlegame + weights.endgame;
    expect(total).toBeCloseTo(1, 6);
  });

  it('gives the weaker phase more practice', () => {
    const weights = practiceWeights(
      buildStrengthProfile([
        breakdown({
          opening: { moves: RATED, accuracy: 90 },
          middlegame: { moves: RATED, accuracy: 70 },
          endgame: { moves: RATED, accuracy: 50 },
        }),
      ]),
    );

    expect(weights.endgame).toBeGreaterThan(weights.middlegame);
    expect(weights.middlegame).toBeGreaterThan(weights.opening);
    // 10 : 30 : 50 of accuracy given away.
    expect(weights.endgame).toBeCloseTo(50 / 90, 6);
  });

  it('gives an unrated phase the mean of the rated ones, so it is still practised', () => {
    const weights = practiceWeights(
      buildStrengthProfile([
        breakdown({
          opening: { moves: RATED, accuracy: 90 },
          middlegame: { moves: RATED, accuracy: 70 },
          endgame: { moves: 0 },
        }),
      ]),
    );

    // Headroom 10 and 30 rated, mean 20 for the unrated endgame.
    expect(weights.opening).toBeCloseTo(10 / 60, 6);
    expect(weights.middlegame).toBeCloseTo(30 / 60, 6);
    expect(weights.endgame).toBeCloseTo(20 / 60, 6);
  });

  it('falls back to an even split when a player gives nothing away anywhere', () => {
    const weights = practiceWeights(
      buildStrengthProfile([
        breakdown({
          opening: { moves: RATED, accuracy: 100 },
          middlegame: { moves: RATED, accuracy: 100 },
          endgame: { moves: RATED, accuracy: 100 },
        }),
      ]),
    );

    expect(weights.opening).toBeCloseTo(1 / 3, 6);
    expect(weights.endgame).toBeCloseTo(1 / 3, 6);
  });
});
