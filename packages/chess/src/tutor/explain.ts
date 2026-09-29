import { Chess, type Move } from 'chess.js';

import { plyLabel } from '../line-drill';
import type { PlyFacts } from '../lines';
import { DETECTORS } from './detectors';
import type { Detector, MoveContext, Motif, TutorLine, TutorPly } from './types';

/**
 * Turning a ply into an explanation: build the context, run every detector, keep the heaviest.
 * No model, no network — the same ply always gets the same words. See
 * docs/adr/0008-computed-tutor-and-learn-mode.md.
 */

/** Three clauses read well; six is a wall. */
export const MAX_MOTIFS = 3;

/** A motif that says the same thing as a heavier one is dropped when that one fires. */
const SUPERSEDED_BY: Record<string, readonly string[]> = {
  'attacks-piece': ['fork', 'pin', 'wins-material'],
  check: ['fork', 'checkmate'],
  'one-of-several': ['only-move'],
};

function play(position: Chess, san: string): Move {
  const board = new Chess(position.fen());
  return board.move(san);
}

/** The context for one move, from the position before it. Throws on an illegal move. */
export function contextFor(input: {
  fenBefore: string;
  san: string;
  previous?: { fenBefore: string; san: string } | null;
  facts?: PlyFacts | null;
  rest?: readonly TutorPly[];
}): MoveContext {
  const before = new Chess(input.fenBefore);
  const after = new Chess(input.fenBefore);
  const move = after.move(input.san);
  const previous = input.previous
    ? play(new Chess(input.previous.fenBefore), input.previous.san)
    : null;
  return {
    before,
    after,
    move,
    previous,
    facts: input.facts ?? null,
    rest: input.rest ?? [],
  };
}

/** The context for the ply at `index` of a stored line. */
export function lineContext(plies: readonly TutorPly[], index: number): MoveContext {
  const ply = plies[index];
  if (!ply) throw new Error(`no ply at index ${index}`);
  return contextFor({
    fenBefore: ply.fenBefore,
    san: ply.san,
    previous: plies[index - 1] ?? null,
    facts: ply.facts ?? null,
    rest: plies.slice(index + 1),
  });
}

/** Every motif that fires, heaviest first, ties in detector order, restatements dropped. */
export function detectMotifs(
  ctx: MoveContext,
  detectors: readonly Detector[] = DETECTORS,
): Motif[] {
  const fired = detectors
    .map((detect, order) => ({ motif: detect(ctx), order }))
    .filter((entry): entry is { motif: Motif; order: number } => entry.motif !== null)
    .sort((a, b) => b.motif.weight - a.motif.weight || a.order - b.order)
    .map((entry) => entry.motif);
  const ids = new Set(fired.map((m) => m.id));
  return fired.filter((m) => !(SUPERSEDED_BY[m.id] ?? []).some((id) => ids.has(id)));
}

/** What is worth saying about a move: at most `MAX_MOTIFS` clauses. */
export function explainMove(ctx: MoveContext): Motif[] {
  return detectMotifs(ctx).slice(0, MAX_MOTIFS);
}

/**
 * The stored evaluation after a move, as a person reads it: `+0.14`, `-1.20`, `White mates in 3`.
 * Null without facts — the tutor does not show a score it was not given.
 */
export function formatScore(facts: PlyFacts | null | undefined): string | null {
  if (!facts) return null;
  if (facts.mateIn !== null) {
    if (facts.mateIn === 0) return 'mate';
    return `${facts.mateIn > 0 ? 'White' : 'Black'} mates in ${Math.abs(facts.mateIn)}`;
  }
  if (facts.scoreCp === null) return null;
  const pawns = (facts.scoreCp / 100).toFixed(2);
  return facts.scoreCp > 0 ? `+${pawns}` : pawns;
}

/**
 * What kind of move this is, from where the generator took it. A `branch` is one of several
 * replies the engine rated close to its best; an `engine` move is its single choice (ADR 0007).
 * `branchCount` is how many replies the stored lines hold at this node, when the caller knows.
 */
export function describeSource(
  ply: Pick<TutorPly, 'source' | 'color'>,
  learnerColor: 'w' | 'b',
  branchCount?: number,
): string {
  switch (ply.source) {
    case 'opening':
      return "Part of the opening's definition: every line of it starts this way, whatever an engine would choose.";
    case 'engine':
      return ply.color === learnerColor
        ? "The engine's move: the one answer this repertoire plays in this position."
        : "The engine's reply: past the branching, the opponent plays its single choice.";
    case 'branch':
      return branchCount !== undefined && branchCount > 1
        ? `One of ${branchCount} replies the engine rated close to its best. This line follows this one; the others are lines of their own.`
        : 'One of several replies the engine rated close to its best. This line follows this one; the others are lines of their own.';
    case 'book':
      return 'A continuation from the opening book, stored before the engine chose the branches.';
  }
}

export interface PlyExplanation {
  ply: number;
  /** `4.d4`, `3...a6`. */
  label: string;
  /** What kind of move it is — see `describeSource`. */
  source: string;
  motifs: Motif[];
  /** The stored evaluation after the move, White's view; null when none was stored. */
  evaluation: string | null;
}

/** Explain the ply at `index` of a stored line. */
export function explainPly(
  line: TutorLine,
  index: number,
  options: { branchCount?: number } = {},
): PlyExplanation {
  const ply = line.plies[index];
  if (!ply) throw new Error(`no ply at index ${index}`);
  return {
    ply: ply.ply,
    label: plyLabel(ply.ply, ply.san),
    source: describeSource(ply, line.learnerColor, options.branchCount),
    motifs: explainMove(lineContext(line.plies, index)),
    evaluation: formatScore(ply.facts),
  };
}

/** A clause as a sentence: capitalised, full stop. */
export function sentence(clause: string): string {
  const text = clause.trim();
  if (!text) return text;
  const capitalised = text[0]!.toUpperCase() + text.slice(1);
  return /[.!?]$/.test(capitalised) ? capitalised : `${capitalised}.`;
}
