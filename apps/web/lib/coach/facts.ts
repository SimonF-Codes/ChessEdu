import {
  type Classification,
  type GameReview,
  type KeyMoment,
  type KeyMomentReason,
  type Phase,
  formatEvaluation,
  moveAt,
} from '@chessedu/chess';

/**
 * The *given facts* half of the coaching boundary.
 *
 * Every number in a coaching prompt is assembled here, straight out of what the engine wrote
 * to `move_analysis`. The model receives this block and is asked for the idea behind it; it is
 * never handed a position without its evaluation, and never asked which move was better. See
 * the coaching boundary and the review coach in docs/architecture.md.
 */

export interface MomentFacts {
  ply: number;
  /** `21...` — how the move is written in the game score. */
  label: string;
  reason: KeyMomentReason;
  /** Whose move it was, relative to the player being coached. */
  side: 'player' | 'opponent';
  classification: Classification;
  phase: Phase;
  fenBefore: string;
  played: string;
  engineBest: string | null;
  engineLine: string[];
  evalBefore: string;
  evalAfter: string;
  centipawnLoss: number;
  winPercentLoss: number;
  clock: string | null;
  annotation: string;
}

/** `0:55`, `10:02`, `1:00:00`. Null when the PGN carried no clock. */
export function formatClock(clockMs: number | null): string | null {
  if (clockMs === null || !Number.isFinite(clockMs) || clockMs < 0) return null;
  const total = Math.round(clockMs / 1000);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const mm = hours > 0 ? String(minutes).padStart(2, '0') : String(minutes);
  return `${hours > 0 ? `${hours}:` : ''}${mm}:${String(seconds).padStart(2, '0')}`;
}

export function momentFactsFor(review: GameReview, moment: KeyMoment): MomentFacts | null {
  const move = moveAt(review, moment.ply);
  if (move === null) return null;

  return {
    ply: move.ply,
    label: move.label,
    reason: moment.reason,
    side: move.byPlayer ? 'player' : 'opponent',
    classification: move.classification,
    phase: move.phase,
    fenBefore: move.fenBefore,
    played: move.san,
    engineBest: move.bestMoveSan,
    engineLine: move.bestLineSan,
    evalBefore: formatEvaluation(move.evalBefore),
    evalAfter: formatEvaluation(move.evalAfter),
    centipawnLoss: move.centipawnLoss,
    winPercentLoss: Math.round(move.winPercentLoss),
    clock: formatClock(move.clockMs),
    annotation: move.annotation,
  };
}

/** The facts for every key moment the review picked out, in ply order. */
export function factsForReview(review: GameReview): MomentFacts[] {
  return review.keyMoments
    .map((moment) => momentFactsFor(review, moment))
    .filter((facts): facts is MomentFacts => facts !== null);
}

const REASON_NOTE: Record<KeyMomentReason, string> = {
  'turning-point': 'the largest swing in the game',
  blunder: 'a blunder',
  mistake: 'a mistake',
  inaccuracy: 'an inaccuracy',
  critical: 'a moment the result hinged on',
};

/**
 * One moment as a flat block of engine facts.
 *
 * Deliberately dull and mechanical: no adjectives, no framing, nothing the model could read as
 * a hint about what to conclude.
 */
export function renderFacts(facts: MomentFacts): string {
  const lines = [
    `[ply ${facts.ply}] ${facts.label}${facts.played} — played by ${
      facts.side === 'player' ? 'the player you are coaching' : 'their opponent'
    }, ${REASON_NOTE[facts.reason]}`,
    `  position before the move (FEN): ${facts.fenBefore}`,
    `  engine classification: ${facts.classification}`,
    `  phase: ${facts.phase}`,
    `  evaluation before the move: ${facts.evalBefore}`,
    `  evaluation after the move: ${facts.evalAfter}`,
    `  centipawns given up: ${facts.centipawnLoss}`,
    `  win chance given up: ${facts.winPercentLoss}%`,
  ];

  if (facts.engineBest !== null) {
    lines.push(`  engine's move instead: ${facts.engineBest}`);
  }
  if (facts.engineLine.length > 0) {
    lines.push(`  engine's line: ${facts.engineLine.join(' ')}`);
  }
  if (facts.clock !== null) {
    lines.push(`  clock remaining after the move: ${facts.clock}`);
  }

  return lines.join('\n');
}

/** The header facts about the game itself, given once. */
export function renderGameFacts(review: GameReview): string {
  const lines = [
    `The player you are coaching had ${review.perspective === 'w' ? 'White' : 'Black'} and ${
      review.result === 'win' ? 'won' : review.result === 'loss' ? 'lost' : 'drew'
    }.`,
    `Opponent: ${review.opponentUsername}${
      review.opponentRating === null ? '' : ` (${review.opponentRating})`
    }.`,
    `Time control: ${review.timeControl}. Moves: ${review.moves.length} plies.`,
  ];

  if (review.eco !== null) lines.push(`Opening (ECO): ${review.eco}.`);
  if (review.accuracy.player !== null) {
    lines.push(`Engine accuracy — player: ${review.accuracy.player.toFixed(1)}%.`);
  }
  if (review.accuracy.opponent !== null) {
    lines.push(`Engine accuracy — opponent: ${review.accuracy.opponent.toFixed(1)}%.`);
  }

  return lines.join('\n');
}

/**
 * The corpus query for one moment.
 *
 * Built from what the engine already established — phase, opening, and the line it wanted —
 * so retrieval is steered by the position rather than by anything the model has said.
 */
export function retrievalQuery(review: GameReview, facts: MomentFacts): string {
  const parts = [
    review.eco ?? '',
    facts.phase,
    facts.classification === 'good' ? 'critical moment' : facts.classification,
    `after ${facts.label}${facts.played}`,
  ];
  if (facts.engineLine.length > 0) parts.push(`engine line ${facts.engineLine.join(' ')}`);
  else if (facts.engineBest !== null) parts.push(`engine move ${facts.engineBest}`);

  return parts
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .join(' ');
}
