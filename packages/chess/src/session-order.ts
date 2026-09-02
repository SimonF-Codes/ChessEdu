/**
 * Which of the due puzzles a review session shows, and in what order.
 *
 * SM-2 (srs.ts) decides *when* a puzzle becomes eligible. Far more puzzles come due than fit in
 * one session, so eligibility is not an ordering — and ordering by `due_at` alone is generation
 * order, which is chronological by game and targets nothing the player is actually weak at.
 *
 * The policy, in one line: among puzzles SM-2 has made due, rank by a blend of how overdue the
 * puzzle is *relative to its own interval* and how often the player fails its theme, then cap how
 * much of a session any one theme may take. See ADR 0004 for the alternatives that lost.
 *
 * Pure, like the rest of this package: the caller supplies the candidate rows and `now`.
 */

/** The fields selection needs. Callers pass their own row type and get it back. */
export interface ReviewCandidate {
  id: string;
  themes: readonly string[];
  dueAt: Date;
  intervalDays: number;
  repetitions: number;
  lapses: number;
}

/**
 * How much of the score is weakness rather than lateness. A blend, not a replacement: at 0 this
 * degenerates to pure due-date order and targets nothing, at 1 it starves the themes the player
 * has mastered and defeats the retention SM-2 exists to provide.
 */
export const THEME_BLEND = 0.4;

/** Beta prior on a theme's failure rate: this many pseudo-reviews at this rate. */
export const THEME_PRIOR_WEIGHT = 6;
export const THEME_PRIOR_RATE = 0.25;

/** No single theme may exceed this share of a session. */
export const MAX_THEME_SHARE = 0.5;

export const DEFAULT_SESSION_SIZE = 10;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Reviews a puzzle has been through. SM-2 resets `repetitions` on a lapse, so this undercounts a
 * puzzle that has lapsed more than once and biases its theme's rate upward — towards the themes
 * this policy wants to surface anyway. ADR 0004 records why that is preferred to a review log.
 */
function attemptsOf(candidate: ReviewCandidate): number {
  return candidate.repetitions + candidate.lapses;
}

/**
 * The smoothed share of reviews that ended in a lapse, per theme, across the given pool.
 *
 * Smoothed because the pool is small and lumpy: without a prior, a theme with one unlucky review
 * scores a perfect 1.0 and outranks a theme with forty genuine failures out of fifty.
 */
export function themeFailureRates(candidates: readonly ReviewCandidate[]): Map<string, number> {
  const totals = new Map<string, { lapses: number; attempts: number }>();

  for (const candidate of candidates) {
    for (const theme of candidate.themes) {
      const total = totals.get(theme) ?? { lapses: 0, attempts: 0 };
      total.lapses += candidate.lapses;
      total.attempts += attemptsOf(candidate);
      totals.set(theme, total);
    }
  }

  const rates = new Map<string, number>();
  for (const [theme, total] of totals) {
    rates.set(
      theme,
      (total.lapses + THEME_PRIOR_WEIGHT * THEME_PRIOR_RATE) /
        (total.attempts + THEME_PRIOR_WEIGHT),
    );
  }
  return rates;
}

/**
 * A puzzle's weakness weight: the worst of its themes. A puzzle tests everything it is tagged
 * with, so it should inherit the priority of the motif the player handles least well.
 */
export function themeFailureRate(
  candidate: ReviewCandidate,
  rates: ReadonlyMap<string, number>,
): number {
  let worst = -1;
  for (const theme of candidate.themes) {
    worst = Math.max(worst, rates.get(theme) ?? THEME_PRIOR_RATE);
  }
  return worst < 0 ? THEME_PRIOR_RATE : worst;
}

/**
 * How late a puzzle is, in units of its own interval, squashed into [0, 1).
 *
 * Relative because a day late on a one-day interval is a real risk of forgetting while a day late
 * on a ninety-day interval is noise. Saturating because a neglected backlog would otherwise let
 * one ancient puzzle outrank everything else indefinitely.
 */
export function overdueUrgency(candidate: ReviewCandidate, now: Date): number {
  const daysLate = (now.getTime() - candidate.dueAt.getTime()) / DAY_MS;
  if (daysLate <= 0) return 0;
  const relative = daysLate / Math.max(candidate.intervalDays, 1);
  return relative / (relative + 1);
}

/** The blended priority a due puzzle is ranked by. Higher is more worth practising now. */
export function candidateScore(
  candidate: ReviewCandidate,
  rates: ReadonlyMap<string, number>,
  now: Date,
): number {
  return (
    (1 - THEME_BLEND) * overdueUrgency(candidate, now) +
    THEME_BLEND * themeFailureRate(candidate, rates)
  );
}

export interface SessionOptions {
  now?: Date;
  sessionSize?: number;
  /** Defaults to `ceil(sessionSize * MAX_THEME_SHARE)`. */
  maxPerTheme?: number;
}

/**
 * Build one review session from a pool of candidate puzzles.
 *
 * Puzzles that are not yet due are dropped — this orders the queue, it does not pull work
 * forward. The rest are scored, sorted (ties broken by due date then id, so the session is
 * deterministic and does not depend on the order rows came back in), and taken greedily under the
 * per-theme cap.
 *
 * The cap then yields: if honouring it would return a short session, the puzzles it skipped are
 * appended in score order. A player whose entire backlog is one motif should still get a full
 * session — the cap is there to diversify where diversity exists, not to withhold practice.
 */
export function selectReviewSession<T extends ReviewCandidate>(
  candidates: readonly T[],
  options: SessionOptions = {},
): T[] {
  const now = options.now ?? new Date();
  const sessionSize = options.sessionSize ?? DEFAULT_SESSION_SIZE;
  if (sessionSize <= 0) return [];

  const maxPerTheme = options.maxPerTheme ?? Math.max(1, Math.ceil(sessionSize * MAX_THEME_SHARE));

  const due = candidates.filter((candidate) => candidate.dueAt.getTime() <= now.getTime());
  if (due.length === 0) return [];

  const rates = themeFailureRates(due);
  const scores = new Map(
    due.map((candidate) => [candidate.id, candidateScore(candidate, rates, now)]),
  );

  const ranked = [...due].sort((a, b) => {
    const byScore = (scores.get(b.id) ?? 0) - (scores.get(a.id) ?? 0);
    if (byScore !== 0) return byScore;
    const byDue = a.dueAt.getTime() - b.dueAt.getTime();
    if (byDue !== 0) return byDue;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

  const selected: T[] = [];
  const skipped: T[] = [];
  const perTheme = new Map<string, number>();

  for (const candidate of ranked) {
    if (selected.length >= sessionSize) break;
    if (candidate.themes.some((theme) => (perTheme.get(theme) ?? 0) >= maxPerTheme)) {
      skipped.push(candidate);
      continue;
    }
    for (const theme of candidate.themes) {
      perTheme.set(theme, (perTheme.get(theme) ?? 0) + 1);
    }
    selected.push(candidate);
  }

  for (const candidate of skipped) {
    if (selected.length >= sessionSize) break;
    selected.push(candidate);
  }

  return selected;
}
