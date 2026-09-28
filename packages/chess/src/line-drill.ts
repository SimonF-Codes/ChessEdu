import { moveLabel } from './game-review';
import { QUICK_SOLVE_MS, type ReviewOutcome } from './srs';

/**
 * The rules of drilling an opening line: how an attempt grades itself, what an attempt the client
 * reports is allowed to contain, which line comes next, and what the history of a line says.
 *
 * The schedule itself is SM-2 in srs.ts, reused unchanged — this module only turns what the board
 * saw into the `ReviewOutcome` srs.ts already speaks. See docs/adr/0006-opening-line-drill.md.
 *
 * Nothing here knows about the book or the engine (that is lines.ts), so it is safe to import from
 * anywhere without pulling in the vendored ECO data.
 */

type Color = 'w' | 'b';

/** How one learner move went. The board observes all four; the learner is never asked. */
export type PlyResult = 'first_try' | 'second_try' | 'revealed' | 'abandoned';

export const PLY_RESULTS: readonly PlyResult[] = [
  'first_try',
  'second_try',
  'revealed',
  'abandoned',
];

/** One learner move within one attempt — one `line_attempt` row. */
export interface PlyAttempt {
  ply: number;
  result: PlyResult;
  /** From the position becoming the learner's to the right move landing (or being revealed). */
  elapsedMs: number;
  /** Legal moves tried that were not the line's, in order. At most two. */
  wrongUci: string[];
}

/** Just enough of a line to grade and describe an attempt at it. */
export interface DrillLine {
  learnerColor: Color;
  plies: readonly { ply: number; color: Color; san: string }[];
}

/** A move that sat on a clock this long was walked away from, not thought about. */
export const MAX_PLY_ELAPSED_MS = 5 * 60 * 1000;

/** The first wrong move gets a retry and the second gets the answer, so no more are ever tried. */
export const MAX_WRONG_MOVES_PER_PLY = 2;

const UCI_PATTERN = /^[a-h][1-8][a-h][1-8][qrbn]?$/;

/** `1.e4`, `1...e5` — how a ply of a line is written for a person. Plies count from move one. */
export function plyLabel(ply: number, san: string): string {
  return `${moveLabel(Math.ceil(ply / 2), ply % 2 === 1 ? 'w' : 'b')}${san}`;
}

/** The moves the learner has to find, in order. */
export function learnerPlies<P extends { color: Color }>(line: {
  learnerColor: Color;
  plies: readonly P[];
}): P[] {
  return line.plies.filter((ply) => ply.color === line.learnerColor);
}

/**
 * Grade an attempt from what the board observed (ADR 0006).
 *
 * The worst move decides: a single reveal or abandon is a lapse however clean the rest was,
 * because a line is only known if all of it is. An attempt shorter than the line was abandoned.
 */
export function lineOutcome(plies: readonly PlyAttempt[], expectedPlies: number): ReviewOutcome {
  if (plies.length < expectedPlies) return 'again';
  if (plies.some((p) => p.result === 'revealed' || p.result === 'abandoned')) return 'again';
  if (plies.some((p) => p.result === 'second_try')) return 'hard';
  return plies.every((p) => p.elapsedMs < QUICK_SOLVE_MS) ? 'easy' : 'good';
}

/**
 * Check an attempt the client reported against the line it claims to be for, and clean it.
 *
 * It must carry exactly one entry per learner move, in order — an abandoned line reports its
 * untried moves as `abandoned`, so nothing is ever missing. Times are clamped and wrong moves
 * trimmed, since the client is not trusted with either. Returns null when the shape is wrong,
 * and the caller records nothing.
 */
export function normaliseAttempt(
  line: DrillLine,
  plies: readonly PlyAttempt[],
): PlyAttempt[] | null {
  const expected = learnerPlies(line);
  if (plies.length !== expected.length) return null;

  const normalised: PlyAttempt[] = [];
  for (const [index, reported] of plies.entries()) {
    if (reported.ply !== expected[index]!.ply) return null;
    if (!PLY_RESULTS.includes(reported.result)) return null;

    const elapsed = Number.isFinite(reported.elapsedMs) ? Math.round(reported.elapsedMs) : 0;
    const wrong =
      reported.result === 'first_try'
        ? []
        : (Array.isArray(reported.wrongUci) ? reported.wrongUci : [])
            .filter((uci) => typeof uci === 'string' && UCI_PATTERN.test(uci))
            .slice(0, MAX_WRONG_MOVES_PER_PLY);

    normalised.push({
      ply: reported.ply,
      result: reported.result,
      elapsedMs: Math.min(MAX_PLY_ELAPSED_MS, Math.max(0, elapsed)),
      wrongUci: wrong,
    });
  }
  return normalised;
}

/** A line as the selector sees it: `dueAt` is null until the user has attempted it once. */
export interface LineCandidate {
  id: string;
  key: string;
  dueAt: Date | null;
}

/**
 * Which line to drill next: the most overdue one the user has already met, else the first one
 * they never have. Review before new, because a line half-learnt and then dropped is the waste
 * spaced repetition exists to prevent. Null when nothing is due and nothing is new.
 */
export function selectNextLine<C extends LineCandidate>(
  candidates: readonly C[],
  now: Date,
): C | null {
  const due = candidates
    .filter((c): c is C & { dueAt: Date } => c.dueAt !== null && c.dueAt.getTime() <= now.getTime())
    .sort((a, b) => a.dueAt.getTime() - b.dueAt.getTime());
  if (due[0]) return due[0];

  const fresh = candidates
    .filter((c) => c.dueAt === null)
    .sort((a, b) => a.key.localeCompare(b.key));
  return fresh[0] ?? null;
}

/** One attempt as read back from `line_attempt`, its plies in order. */
export interface LineAttemptRecord {
  attemptId: string;
  attemptedAt: Date;
  plies: PlyAttempt[];
}

export interface PlyHistory {
  ply: number;
  san: string;
  label: string;
  attempts: number;
  firstTry: number;
  /** Consecutive most-recent attempts in which this move was not found first time. */
  missStreak: number;
  lastResult: PlyResult | null;
}

export interface LineHistory {
  attempts: number;
  plies: PlyHistory[];
  /** Learner moves found first time, from the start, in the latest attempt. */
  cleanPrefix: number;
  /** Where the latest attempt first went wrong; null when it was clean or there is none. */
  breakdown: PlyHistory | null;
  summary: string;
}

/**
 * What the record of a line says, per move — "first 3 moves clean — 4.Qa4 missed 3 times
 * running". `attempts` is newest first, as the query returns them. Everything is computed from
 * the per-ply rows; there is no stored summary to disagree with them.
 */
export function summariseLineHistory(
  line: DrillLine,
  attempts: readonly LineAttemptRecord[],
): LineHistory {
  const plies: PlyHistory[] = learnerPlies(line).map(({ ply, san }) => {
    const results = attempts.map((a) => a.plies.find((p) => p.ply === ply)?.result ?? null);
    let missStreak = 0;
    for (const result of results) {
      if (result === null || result === 'first_try') break;
      missStreak += 1;
    }
    return {
      ply,
      san,
      label: plyLabel(ply, san),
      attempts: results.filter((r) => r !== null).length,
      firstTry: results.filter((r) => r === 'first_try').length,
      missStreak,
      lastResult: results[0] ?? null,
    };
  });

  if (attempts.length === 0) {
    return { attempts: 0, plies, cleanPrefix: 0, breakdown: null, summary: 'Not attempted yet.' };
  }

  const firstMiss = plies.findIndex((p) => p.lastResult !== 'first_try');
  if (firstMiss === -1) {
    return {
      attempts: attempts.length,
      plies,
      cleanPrefix: plies.length,
      breakdown: null,
      summary: `All ${plies.length} moves clean.`,
    };
  }

  const breakdown = plies[firstMiss]!;
  const weakest = plies.reduce<PlyHistory | null>(
    (worst, p) => (p.missStreak >= 2 && (!worst || p.missStreak > worst.missStreak) ? p : worst),
    null,
  );

  const streak = weakest ? `${weakest.label} missed ${weakest.missStreak} times running` : null;
  let summary: string;
  if (firstMiss > 0) {
    const head = firstMiss === 1 ? 'First move clean' : `First ${firstMiss} moves clean`;
    summary = `${head} — ${streak ?? `broke down at ${breakdown.label}`}.`;
  } else if (streak && weakest !== breakdown) {
    summary = `Broke down on the first move, ${breakdown.label} — ${streak}.`;
  } else if (streak) {
    summary = `${streak}.`;
  } else {
    summary = `Broke down on the first move, ${breakdown.label}.`;
  }

  return { attempts: attempts.length, plies, cleanPrefix: firstMiss, breakdown, summary };
}
