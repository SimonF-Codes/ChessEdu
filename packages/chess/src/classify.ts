/**
 * Turning raw engine output into the judgements the education system is built on.
 *
 * Everything here is a pure function of Stockfish evaluations. The LLM never decides any of
 * it — see the coaching boundary in docs/architecture.md.
 */

export type Color = 'w' | 'b';

export type Classification = 'blunder' | 'mistake' | 'inaccuracy' | 'good';

/** An engine evaluation, always stored from White's perspective. */
export interface Evaluation {
  /** Centipawns, or null when the engine reports a forced mate. */
  cp: number | null;
  /** Plies-to-mate, positive when White mates, negative when Black mates. */
  mateIn: number | null;
}

/**
 * Win-percentage drops (not raw centipawns) that separate the classes. Using win percentage
 * makes the thresholds scale-aware: dropping 1000cp when already lost is not a blunder,
 * because it changes nothing about the likely result.
 */
export const BLUNDER_WIN_PCT = 20;
export const MISTAKE_WIN_PCT = 10;
export const INACCURACY_WIN_PCT = 5;

/** A move is "critical" when the position crosses from clearly better to clearly worse. */
const CRITICAL_UPPER = 55;
const CRITICAL_LOWER = 45;

const MATE_BASE = 10_000;

/** Lichess's logistic mapping from centipawns to expected score. */
const WIN_PCT_K = 0.00368208;

/** Lichess's accuracy curve, fitted against real game outcomes. */
const ACC_A = 103.1668;
const ACC_B = -0.04354;
const ACC_C = -3.1669;

/**
 * Collapse an evaluation to a single comparable number. A forced mate outranks any centipawn
 * score, and a faster mate outranks a slower one.
 */
export function centipawnsFor(evaluation: Evaluation): number {
  if (evaluation.mateIn !== null) {
    const magnitude = MATE_BASE - Math.min(Math.abs(evaluation.mateIn), 99) * 10;
    return evaluation.mateIn >= 0 ? magnitude : -magnitude;
  }
  return evaluation.cp ?? 0;
}

/** Expected score for White, as a percentage. */
export function winPercent(cp: number): number {
  const pct = 100 / (1 + Math.exp(-WIN_PCT_K * cp));
  return Math.min(100, Math.max(0, pct));
}

/** Flip an evaluation into the moving side's perspective. */
function fromMoverPerspective(cp: number, mover: Color): number {
  return mover === 'w' ? cp : -cp;
}

export interface MoveJudgement {
  classification: Classification;
  /** Centipawns given up by this move, from the mover's perspective. Never negative. */
  centipawnLoss: number;
  /** Win percentage given up by this move. The value the classification is derived from. */
  winPercentLoss: number;
  /** True when the move swung the likely result of the game. */
  isCritical: boolean;
}

export function classifyMove(input: {
  /** Evaluation of the position before the move, from White's perspective. */
  before: Evaluation;
  /** Evaluation after the move, from White's perspective. */
  after: Evaluation;
  mover: Color;
}): MoveJudgement {
  const beforeCp = fromMoverPerspective(centipawnsFor(input.before), input.mover);
  const afterCp = fromMoverPerspective(centipawnsFor(input.after), input.mover);

  const centipawnLoss = Math.max(0, beforeCp - afterCp);
  const beforePct = winPercent(beforeCp);
  const afterPct = winPercent(afterCp);
  const winPercentLoss = Math.max(0, beforePct - afterPct);

  let classification: Classification = 'good';
  if (winPercentLoss >= BLUNDER_WIN_PCT) classification = 'blunder';
  else if (winPercentLoss >= MISTAKE_WIN_PCT) classification = 'mistake';
  else if (winPercentLoss >= INACCURACY_WIN_PCT) classification = 'inaccuracy';

  const isCritical = beforePct >= CRITICAL_UPPER && afterPct <= CRITICAL_LOWER;

  return { classification, centipawnLoss, winPercentLoss, isCritical };
}

/** Per-move accuracy in 0..100, from the win percentage the move gave up. */
export function moveAccuracy(winPercentLoss: number): number {
  const raw = ACC_A * Math.exp(ACC_B * winPercentLoss) + ACC_C;
  return Math.min(100, Math.max(0, raw));
}

/**
 * Accuracy across one side's moves in a game, as a harmonic mean so that a single disaster
 * dominates a run of adequate moves — which is how the game actually went.
 *
 * Returns null when the side made no moves. Individual accuracies are floored at 1 to keep
 * the mean finite when a move scores zero.
 */
export function gameAccuracy(winPercentLosses: readonly number[]): number | null {
  if (winPercentLosses.length === 0) return null;
  const reciprocalSum = winPercentLosses.reduce(
    (sum, loss) => sum + 1 / Math.max(1, moveAccuracy(loss)),
    0,
  );
  return winPercentLosses.length / reciprocalSum;
}
