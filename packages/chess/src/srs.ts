/**
 * SM-2 spaced repetition, as pure functions.
 *
 * This module owns *when* a puzzle comes back. It does not own *which* of the due puzzles a
 * session shows — that is a separate decision, in review.ts, for the reasons in ADR 0002.
 *
 * Nothing here reads a clock or a database: the caller passes the current state and `now`, and
 * gets the next state back. That is what makes the schedule testable at the boundaries that
 * actually matter (a first review, a lapse from a long interval, the ease floor).
 */

/** SM-2 grades a recalled item 0 (blank) to 5 (perfect). */
export type Grade = 0 | 1 | 2 | 3 | 4 | 5;

/** The scheduling state stored on a puzzle row. */
export interface SrsState {
  /** Days until the next review, as scheduled at the last review. Zero before any review. */
  intervalDays: number;
  /** SM-2 easiness factor: the multiplier the interval grows by. */
  ease: number;
  /** Consecutive successful reviews. Reset to zero by a lapse. */
  repetitions: number;
  /** Lifetime count of failed reviews. Never reset — it is the record of a hard puzzle. */
  lapses: number;
}

export interface ScheduledReview extends SrsState {
  dueAt: Date;
}

/** SM-2's floor. Below this an item is being scheduled faster than it is being learned. */
export const MIN_EASE = 1.3;
export const INITIAL_EASE = 2.5;

/** Grades at or above this are a pass; below it the item has lapsed. */
export const PASSING_GRADE = 3;

export const FIRST_INTERVAL_DAYS = 1;
export const SECOND_INTERVAL_DAYS = 6;

/** A lapsed puzzle comes back tomorrow, whatever interval it had reached. */
export const LAPSE_INTERVAL_DAYS = 1;

/**
 * A year. SM-2 will happily schedule a well-known item decades out; a puzzle from your own game
 * is worth seeing again inside a year regardless of how easy it has become.
 */
export const MAX_INTERVAL_DAYS = 365;

export const INITIAL_SRS_STATE: SrsState = {
  intervalDays: 0,
  ease: INITIAL_EASE,
  repetitions: 0,
  lapses: 0,
};

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * What the review UI can actually observe, mapped onto SM-2 grades. The board knows whether the
 * player found the move, how many tries it took, and how long it took — not a self-assessment.
 */
export type ReviewOutcome = 'again' | 'hard' | 'good' | 'easy';

export const OUTCOME_GRADES: Record<ReviewOutcome, Grade> = {
  again: 1,
  hard: 3,
  good: 4,
  easy: 5,
};

/** A clean solve inside this counts as effortless recall, and earns the ease increase. */
export const QUICK_SOLVE_MS = 10_000;

/** How a solved (or unsolved) puzzle grades itself. */
export function outcomeFor(input: {
  /** Legal moves played that were not the solution. */
  wrongAttempts: number;
  /** True when the player gave up and asked for the answer. */
  revealed: boolean;
  /** Time from showing the position to resolving it. */
  elapsedMs: number;
}): ReviewOutcome {
  if (input.revealed || input.wrongAttempts >= 2) return 'again';
  if (input.wrongAttempts === 1) return 'hard';
  return input.elapsedMs < QUICK_SOLVE_MS ? 'easy' : 'good';
}

/**
 * SM-2's easiness update. Grade 4 is neutral; better raises it, worse lowers it, and the floor
 * stops a chronically failed item from being scheduled into a loop it can never escape.
 */
export function nextEase(ease: number, grade: Grade): number {
  const delta = 0.1 - (5 - grade) * (0.08 + (5 - grade) * 0.02);
  return Math.max(MIN_EASE, ease + delta);
}

/** Whole days, and never less than a day: sub-day scheduling is not a thing this product does. */
function clampInterval(days: number): number {
  return Math.min(MAX_INTERVAL_DAYS, Math.max(FIRST_INTERVAL_DAYS, Math.round(days)));
}

/**
 * Grade one review and return the state to store, including the new due date.
 *
 * A pass advances `repetitions` and lengthens the interval; the first two intervals are fixed
 * (SM-2's 1 and 6 days) and everything after that multiplies by the *updated* ease. A failure is
 * a lapse: the interval collapses to tomorrow and rebuilding starts from the first interval
 * again, because a puzzle you have just forgotten is not a puzzle you know in six days.
 */
export function gradeReview(
  state: SrsState,
  grade: Grade,
  now: Date = new Date(),
): ScheduledReview {
  const ease = nextEase(state.ease, grade);

  if (grade < PASSING_GRADE) {
    return {
      intervalDays: LAPSE_INTERVAL_DAYS,
      ease,
      repetitions: 0,
      lapses: state.lapses + 1,
      dueAt: new Date(now.getTime() + LAPSE_INTERVAL_DAYS * DAY_MS),
    };
  }

  const repetitions = state.repetitions + 1;
  const intervalDays =
    repetitions === 1
      ? FIRST_INTERVAL_DAYS
      : repetitions === 2
        ? SECOND_INTERVAL_DAYS
        : clampInterval(state.intervalDays * ease);

  return {
    intervalDays,
    ease,
    repetitions,
    lapses: state.lapses,
    dueAt: new Date(now.getTime() + intervalDays * DAY_MS),
  };
}

/** `gradeReview` in the vocabulary the UI speaks, so no caller handles a raw SM-2 grade. */
export function reviewPuzzle(
  state: SrsState,
  outcome: ReviewOutcome,
  now: Date = new Date(),
): ScheduledReview {
  return gradeReview(state, OUTCOME_GRADES[outcome], now);
}
