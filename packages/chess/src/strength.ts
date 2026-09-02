import type { Color } from './classify';
import type { Phase } from './phase';

/**
 * The per-phase strength model: how well a player actually plays each phase, accumulated over
 * every analysed game. See section 9 of docs/architecture.md.
 *
 * Every number here is engine output or a pure function of engine output. Nothing in this file
 * may be produced, rounded or ranked by a language model — the engine evaluates, the model only
 * explains (the coaching boundary, section 6). It is also I/O-free: callers hand it rows they
 * have already read.
 */

export const PHASES: readonly Phase[] = ['opening', 'middlegame', 'endgame'];

/**
 * One side's play in one phase of one game — the unit the worker writes into
 * `game_analysis.phase_breakdown`, and the unit profiles are built from.
 */
export interface PhaseSample {
  /** Plies this side played in the phase. */
  moves: number;
  /** 0..100 on the accuracy curve in classify.ts. Null when the phase was never reached. */
  accuracy: number | null;
  averageCentipawnLoss: number;
  blunders: number;
}

/** All three phases, always. A phase the game never reached is an empty sample, not a gap. */
export type PhaseBreakdown = Record<Phase, PhaseSample>;

/** The shape of the `game_analysis.phase_breakdown` column: both sides of one game. */
export interface GamePhaseBreakdown {
  white: PhaseBreakdown;
  black: PhaseBreakdown;
}

export function emptyPhaseSample(): PhaseSample {
  return { moves: 0, accuracy: null, averageCentipawnLoss: 0, blunders: 0 };
}

export function emptyPhaseBreakdown(): PhaseBreakdown {
  return {
    opening: emptyPhaseSample(),
    middlegame: emptyPhaseSample(),
    endgame: emptyPhaseSample(),
  };
}

/**
 * Accuracies are floored the same way `gameAccuracy` floors them, so that a stored zero — or a
 * garbage value from an older row — cannot make the recombination below divide by zero.
 */
const MIN_ACCURACY = 1;

/**
 * Fold several samples of the same phase into one.
 *
 * Accuracy is a harmonic mean, so it recombines *exactly*: the mean over a set of games is
 * `Σmoves / Σ(moves / accuracy)`, which is the number a single pass over every ply would have
 * produced. Averaging the per-game accuracies instead would quietly flatter a player whose bad
 * games were short. Centipawn loss is only move-weighted, so it carries each game's rounding.
 */
export function combinePhaseSamples(samples: readonly PhaseSample[]): PhaseSample {
  let moves = 0;
  let blunders = 0;
  let centipawns = 0;
  let reciprocal = 0;
  let accuracyMoves = 0;

  for (const sample of samples) {
    if (sample.moves <= 0) continue;
    moves += sample.moves;
    blunders += sample.blunders;
    centipawns += sample.averageCentipawnLoss * sample.moves;
    if (sample.accuracy === null) continue;
    accuracyMoves += sample.moves;
    reciprocal += sample.moves / Math.max(MIN_ACCURACY, sample.accuracy);
  }

  return {
    moves,
    accuracy: reciprocal > 0 ? accuracyMoves / reciprocal : null,
    averageCentipawnLoss: moves > 0 ? Math.round(centipawns / moves) : 0,
    blunders,
  };
}

function readNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function readSample(value: unknown): PhaseSample | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;

  const moves = readNumber(record.moves);
  if (moves === null || moves < 0) return null;

  return {
    moves,
    accuracy: readNumber(record.accuracy),
    averageCentipawnLoss: readNumber(record.averageCentipawnLoss) ?? 0,
    blunders: readNumber(record.blunders) ?? 0,
  };
}

/**
 * Read one side out of a `game_analysis.phase_breakdown` value.
 *
 * The column is jsonb, so it arrives untyped and may predate a field, and it is null for a game
 * the worker has not analysed yet. Returning null rather than throwing lets a caller count that
 * game as pending and carry on; a phase that is merely missing is filled in as empty.
 */
export function phaseBreakdownFor(value: unknown, color: Color): PhaseBreakdown | null {
  if (typeof value !== 'object' || value === null) return null;

  const sides = value as Record<string, unknown>;
  const side = color === 'w' ? sides.white : sides.black;
  if (typeof side !== 'object' || side === null) return null;

  const samples = side as Record<string, unknown>;
  const breakdown = emptyPhaseBreakdown();
  let found = 0;
  for (const phase of PHASES) {
    const sample = readSample(samples[phase]);
    if (!sample) continue;
    breakdown[phase] = sample;
    found += 1;
  }

  return found > 0 ? breakdown : null;
}

/**
 * How many of the most recent games a profile is built from.
 *
 * Older games describe a player who no longer exists, and one row per game keeps this cheap
 * even at the limit. Every consumer of the model uses the same window, so that two surfaces
 * never quote different numbers for the same player.
 */
export const STRENGTH_WINDOW = 200;

/** How much play a phase needs before its numbers are reported as a strength or a weakness. */
export const MIN_MOVES_PER_PHASE = 150;

export interface PhaseStrength extends PhaseSample {
  phase: Phase;
  /** Games that reached this phase at all. */
  games: number;
  blundersPerHundredMoves: number;
  /** Accuracy points behind this player's own best rated phase. Null while unrated. */
  deficit: number | null;
  /** False below MIN_MOVES_PER_PHASE, where the numbers are noise. */
  rated: boolean;
}

export interface StrengthProfile {
  /** Games folded in. */
  games: number;
  /** Plies across all phases. */
  moves: number;
  phases: Record<Phase, PhaseStrength>;
  /** The weakest rated phase — what to work on. Null until something is rated. */
  focus: Phase | null;
  strongest: Phase | null;
}

/**
 * Build a profile from one breakdown per game, each already narrowed to the player's own side.
 *
 * Safe on an empty history: a player who signed up a minute ago gets a profile of nulls rather
 * than a confident verdict drawn from four moves.
 */
export function buildStrengthProfile(breakdowns: readonly PhaseBreakdown[]): StrengthProfile {
  const phases = {} as Record<Phase, PhaseStrength>;

  for (const phase of PHASES) {
    const samples = breakdowns.map((breakdown) => breakdown[phase]);
    const combined = combinePhaseSamples(samples);
    phases[phase] = {
      ...combined,
      phase,
      games: samples.filter((sample) => sample.moves > 0).length,
      blundersPerHundredMoves: combined.moves > 0 ? (combined.blunders * 100) / combined.moves : 0,
      deficit: null,
      rated: combined.moves >= MIN_MOVES_PER_PHASE && combined.accuracy !== null,
    };
  }

  const rated = PHASES.filter((phase) => phases[phase].rated);
  let focus: Phase | null = null;
  let strongest: Phase | null = null;

  if (rated.length > 0) {
    const accuracyOf = (phase: Phase) => phases[phase].accuracy ?? 0;
    focus = rated.reduce((worst, phase) => (accuracyOf(phase) < accuracyOf(worst) ? phase : worst));
    strongest = rated.reduce((best, phase) =>
      accuracyOf(phase) > accuracyOf(best) ? phase : best,
    );

    const ceiling = accuracyOf(strongest);
    for (const phase of rated) {
      phases[phase].deficit = ceiling - accuracyOf(phase);
    }
  }

  return {
    games: breakdowns.length,
    moves: PHASES.reduce((total, phase) => total + phases[phase].moves, 0),
    phases,
    focus,
    strongest,
  };
}

/**
 * How to divide practice between the phases, as a distribution summing to 1.
 *
 * Weight is proportional to the accuracy a phase is still giving away (`100 - accuracy`), which
 * needs no invented constant: a phase played at 70% earns three times the practice of one
 * played at 90%. A phase that is not rated yet is given the mean weight of the rated ones, so a
 * new player is practised everywhere rather than nowhere.
 *
 * `chessedu-play` uses this to decide how often a drill or bot game starts from each phase.
 */
export function practiceWeights(profile: StrengthProfile): Record<Phase, number> {
  const even = 1 / PHASES.length;
  const headroom = new Map<Phase, number>();

  for (const phase of PHASES) {
    const strength = profile.phases[phase];
    if (!strength.rated || strength.accuracy === null) continue;
    headroom.set(phase, Math.max(0, 100 - strength.accuracy));
  }

  const rated = [...headroom.values()];
  const meanRated = rated.length > 0 ? rated.reduce((a, b) => a + b, 0) / rated.length : 0;

  const weights = PHASES.map((phase) => headroom.get(phase) ?? meanRated);
  const total = weights.reduce((a, b) => a + b, 0);

  return Object.fromEntries(
    PHASES.map((phase, index) => [phase, total > 0 ? weights[index]! / total : even]),
  ) as Record<Phase, number>;
}
