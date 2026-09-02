import { describe, expect, it } from 'vitest';

import {
  FIRST_INTERVAL_DAYS,
  INITIAL_EASE,
  INITIAL_SRS_STATE,
  LAPSE_INTERVAL_DAYS,
  MAX_INTERVAL_DAYS,
  MIN_EASE,
  OUTCOME_GRADES,
  QUICK_SOLVE_MS,
  SECOND_INTERVAL_DAYS,
  type SrsState,
  gradeReview,
  nextEase,
  outcomeFor,
  reviewPuzzle,
} from './srs';

const NOW = new Date('2026-08-27T12:00:00.000Z');

const DAY_MS = 24 * 60 * 60 * 1000;

/** Days between `now` and a scheduled due date, so assertions read in the unit SM-2 works in. */
function daysUntil(dueAt: Date, from: Date = NOW): number {
  return (dueAt.getTime() - from.getTime()) / DAY_MS;
}

function state(overrides: Partial<SrsState> = {}): SrsState {
  return { ...INITIAL_SRS_STATE, ...overrides };
}

describe('nextEase', () => {
  it('leaves ease untouched on a grade 4 — the definition of an unremarkable pass', () => {
    expect(nextEase(2.5, 4)).toBeCloseTo(2.5, 10);
  });

  it('raises ease on a grade 5 and lowers it on a grade 3', () => {
    expect(nextEase(2.5, 5)).toBeCloseTo(2.6, 10);
    expect(nextEase(2.5, 3)).toBeCloseTo(2.36, 10);
  });

  it('drops ease hardest on the worst grade', () => {
    expect(nextEase(2.5, 0)).toBeLessThan(nextEase(2.5, 1));
    expect(nextEase(2.5, 1)).toBeLessThan(nextEase(2.5, 2));
  });

  it('never falls below the ease floor, however many failures', () => {
    let ease = INITIAL_EASE;
    for (let i = 0; i < 50; i += 1) ease = nextEase(ease, 0);
    expect(ease).toBe(MIN_EASE);
  });
});

describe('gradeReview', () => {
  it('schedules a first pass one day out', () => {
    const result = gradeReview(state(), 4, NOW);
    expect(result.repetitions).toBe(1);
    expect(result.intervalDays).toBe(FIRST_INTERVAL_DAYS);
    expect(daysUntil(result.dueAt)).toBe(FIRST_INTERVAL_DAYS);
  });

  it('schedules a second pass by the fixed second interval, not by ease', () => {
    const first = gradeReview(state(), 4, NOW);
    const second = gradeReview(first, 4, NOW);
    expect(second.repetitions).toBe(2);
    expect(second.intervalDays).toBe(SECOND_INTERVAL_DAYS);
  });

  it('multiplies by ease from the third pass onwards', () => {
    const third = gradeReview(
      state({ intervalDays: SECOND_INTERVAL_DAYS, ease: 2.5, repetitions: 2 }),
      4,
      NOW,
    );
    expect(third.repetitions).toBe(3);
    expect(third.intervalDays).toBe(Math.round(SECOND_INTERVAL_DAYS * 2.5));
    expect(daysUntil(third.dueAt)).toBe(third.intervalDays);
  });

  it('applies the new ease to the interval, so a grade 3 pass grows more slowly than a grade 5', () => {
    const base = state({ intervalDays: 10, ease: 2.5, repetitions: 3 });
    expect(gradeReview(base, 3, NOW).intervalDays).toBeLessThan(
      gradeReview(base, 5, NOW).intervalDays,
    );
  });

  it('caps the interval so a long-lived puzzle still comes back', () => {
    const result = gradeReview(
      state({ intervalDays: MAX_INTERVAL_DAYS, ease: 2.5, repetitions: 9 }),
      5,
      NOW,
    );
    expect(result.intervalDays).toBe(MAX_INTERVAL_DAYS);
  });

  it('does not mutate the state it was given', () => {
    const before = state({ intervalDays: 10, repetitions: 3 });
    const snapshot = { ...before };
    gradeReview(before, 5, NOW);
    expect(before).toEqual(snapshot);
  });

  describe('a lapse', () => {
    it('resets a long interval to the lapse interval and counts the lapse', () => {
      const long = state({ intervalDays: 180, ease: 2.4, repetitions: 6, lapses: 1 });
      const result = gradeReview(long, 1, NOW);

      expect(result.intervalDays).toBe(LAPSE_INTERVAL_DAYS);
      expect(daysUntil(result.dueAt)).toBe(LAPSE_INTERVAL_DAYS);
      expect(result.repetitions).toBe(0);
      expect(result.lapses).toBe(2);
      expect(result.ease).toBeLessThan(long.ease);
    });

    it('rebuilds from the first interval rather than resuming the old one', () => {
      const lapsed = gradeReview(state({ intervalDays: 180, repetitions: 6 }), 1, NOW);
      const recovered = gradeReview(lapsed, 4, NOW);
      expect(recovered.intervalDays).toBe(FIRST_INTERVAL_DAYS);
    });

    it('treats grade 2 as a failure and grade 3 as a pass', () => {
      const base = state({ intervalDays: 10, repetitions: 3 });
      expect(gradeReview(base, 2, NOW).lapses).toBe(1);
      expect(gradeReview(base, 3, NOW).lapses).toBe(0);
    });
  });
});

describe('outcomeFor', () => {
  it('calls a quick clean solve easy and an unhurried one good', () => {
    expect(outcomeFor({ wrongAttempts: 0, revealed: false, elapsedMs: QUICK_SOLVE_MS - 1 })).toBe(
      'easy',
    );
    expect(outcomeFor({ wrongAttempts: 0, revealed: false, elapsedMs: QUICK_SOLVE_MS * 10 })).toBe(
      'good',
    );
  });

  it('calls one wrong move hard — still a pass, but the ease should pay for it', () => {
    expect(outcomeFor({ wrongAttempts: 1, revealed: false, elapsedMs: 5_000 })).toBe('hard');
    expect(OUTCOME_GRADES.hard).toBeGreaterThanOrEqual(3);
  });

  it('calls a revealed solution or a second wrong move a failure', () => {
    expect(outcomeFor({ wrongAttempts: 0, revealed: true, elapsedMs: 1_000 })).toBe('again');
    expect(outcomeFor({ wrongAttempts: 2, revealed: false, elapsedMs: 1_000 })).toBe('again');
    expect(OUTCOME_GRADES.again).toBeLessThan(3);
  });
});

describe('reviewPuzzle', () => {
  it('grades by outcome, so callers never handle raw SM-2 numbers', () => {
    const base = state({ intervalDays: 10, ease: 2.5, repetitions: 3 });
    expect(reviewPuzzle(base, 'good', NOW)).toEqual(gradeReview(base, OUTCOME_GRADES.good, NOW));
    expect(reviewPuzzle(base, 'again', NOW).lapses).toBe(1);
  });
});
