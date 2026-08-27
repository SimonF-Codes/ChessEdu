import { describe, expect, it } from 'vitest';

import {
  centipawnsFor,
  classifyMove,
  gameAccuracy,
  moveAccuracy,
  winPercent,
} from './classify';

describe('centipawnsFor', () => {
  it('passes a plain centipawn score through', () => {
    expect(centipawnsFor({ cp: 45, mateIn: null })).toBe(45);
  });

  it('maps a mate for the side to move to a large positive score', () => {
    expect(centipawnsFor({ cp: null, mateIn: 3 })).toBeGreaterThan(9000);
  });

  it('maps a mate against to a large negative score', () => {
    expect(centipawnsFor({ cp: null, mateIn: -3 })).toBeLessThan(-9000);
  });

  it('ranks a faster mate above a slower one', () => {
    expect(centipawnsFor({ cp: null, mateIn: 1 })).toBeGreaterThan(
      centipawnsFor({ cp: null, mateIn: 8 }),
    );
  });
});

describe('winPercent', () => {
  it('is even at a dead level position', () => {
    expect(winPercent(0)).toBeCloseTo(50, 5);
  });

  it('is symmetric about equality', () => {
    expect(winPercent(300) + winPercent(-300)).toBeCloseTo(100, 5);
  });

  it('rises monotonically with the evaluation', () => {
    const points = [-900, -300, -100, 0, 100, 300, 900].map(winPercent);
    for (let i = 1; i < points.length; i += 1) {
      expect(points[i]!).toBeGreaterThan(points[i - 1]!);
    }
  });

  it('saturates rather than exceeding the bounds', () => {
    expect(winPercent(100_000)).toBeLessThanOrEqual(100);
    expect(winPercent(-100_000)).toBeGreaterThanOrEqual(0);
  });
});

describe('classifyMove', () => {
  const evalCp = (cp: number) => ({ cp, mateIn: null });

  it('calls a move that throws away a winning position a blunder', () => {
    const result = classifyMove({ before: evalCp(300), after: evalCp(-300), mover: 'w' });
    expect(result.classification).toBe('blunder');
    expect(result.centipawnLoss).toBe(600);
  });

  it('calls a moderate slip a mistake', () => {
    expect(classifyMove({ before: evalCp(80), after: evalCp(-90), mover: 'w' }).classification).toBe(
      'mistake',
    );
  });

  it('calls a small slip an inaccuracy', () => {
    expect(classifyMove({ before: evalCp(30), after: evalCp(-45), mover: 'w' }).classification).toBe(
      'inaccuracy',
    );
  });

  it('calls a move that holds the evaluation good', () => {
    expect(classifyMove({ before: evalCp(20), after: evalCp(15), mover: 'w' }).classification).toBe(
      'good',
    );
  });

  it('reads the evaluation from the mover perspective for Black', () => {
    // Evaluations are stored from White's perspective: -300 to +300 is a disaster for Black.
    const result = classifyMove({ before: evalCp(-300), after: evalCp(300), mover: 'b' });
    expect(result.classification).toBe('blunder');
    expect(result.centipawnLoss).toBe(600);
  });

  it('does not punish a move that improves the position', () => {
    const result = classifyMove({ before: evalCp(0), after: evalCp(200), mover: 'w' });
    expect(result.centipawnLoss).toBe(0);
    expect(result.classification).toBe('good');
  });

  it('does not call a move in a hopeless position a blunder', () => {
    // Already lost by any measure; a further drop changes nothing in win-percentage terms.
    const result = classifyMove({
      before: evalCp(-2000),
      after: evalCp(-3000),
      mover: 'w',
    });
    expect(result.classification).toBe('good');
  });

  it('flags a critical moment when the result of the game swings', () => {
    const result = classifyMove({ before: evalCp(250), after: evalCp(-250), mover: 'w' });
    expect(result.isCritical).toBe(true);
  });

  it('does not flag a quiet move as critical', () => {
    expect(classifyMove({ before: evalCp(20), after: evalCp(10), mover: 'w' }).isCritical).toBe(
      false,
    );
  });

  it('treats walking into mate as a blunder', () => {
    const result = classifyMove({
      before: { cp: 50, mateIn: null },
      after: { cp: null, mateIn: -2 },
      mover: 'w',
    });
    expect(result.classification).toBe('blunder');
  });
});

describe('moveAccuracy', () => {
  it('is full marks for a move that loses nothing', () => {
    expect(moveAccuracy(0)).toBeCloseTo(100, 1);
  });

  it('falls as the win percentage lost grows', () => {
    expect(moveAccuracy(20)).toBeLessThan(moveAccuracy(5));
  });

  it('stays within bounds for an enormous loss', () => {
    expect(moveAccuracy(100)).toBeGreaterThanOrEqual(0);
    expect(moveAccuracy(100)).toBeLessThanOrEqual(100);
  });
});

describe('gameAccuracy', () => {
  it('is 100 for a flawless game', () => {
    expect(gameAccuracy([0, 0, 0, 0])).toBeCloseTo(100, 1);
  });

  it('is undefined-safe for a game with no moves by that side', () => {
    expect(gameAccuracy([])).toBeNull();
  });

  it('weights a single disaster heavily, as a harmonic mean should', () => {
    const withBlunder = gameAccuracy([0, 0, 0, 60]);
    const evenlySloppy = gameAccuracy([15, 15, 15, 15]);
    expect(withBlunder).not.toBeNull();
    expect(evenlySloppy).not.toBeNull();
    expect(withBlunder!).toBeLessThan(evenlySloppy!);
  });
});
