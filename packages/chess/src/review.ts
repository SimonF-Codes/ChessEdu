import { Chess } from 'chess.js';

import {
  type Classification,
  type Color,
  type Evaluation,
  centipawnsFor,
  gameAccuracy,
  winPercent,
} from './classify';
import type { GameResult } from './pgn';
import { type Phase, phaseOf } from './phase';

/**
 * Re-exported so the browser can import this module on its own. `./index` reaches `link.ts`,
 * which needs `node:crypto` and cannot be bundled for the client — the walkthrough UI imports
 * `@chessedu/chess/review` instead, and needs these types with it.
 */
export type { Classification, Color, Evaluation } from './classify';
export type { GameResult } from './pgn';
export type { Phase } from './phase';

/**
 * Turning a played game plus its engine analysis into a walkthrough: every ply annotated, and
 * the handful of plies that decided the game picked out.
 *
 * Everything here is a pure function of Stockfish output. The annotations are facts about the
 * evaluation, not opinions about the player — the prose belongs to the coach in apps/web,
 * which is handed these facts and never asked to produce a number. See the coaching boundary
 * and the review coach in docs/architecture.md.
 */

/** A move as stored in `move`. */
export interface ReviewMoveInput {
  ply: number;
  color: Color;
  san: string;
  uci: string;
  fenBefore: string;
  clockMs?: number | null;
}

/** A row of `move_analysis`. Evaluations are stored *after* the move, from White's side. */
export interface ReviewAnalysisInput {
  ply: number;
  evalCp: number | null;
  mateIn: number | null;
  bestMoveUci: string | null;
  pv?: readonly string[] | null;
  centipawnLoss: number;
  winPercentLoss: number;
  classification: Classification;
  phase: Phase;
  isCritical: boolean;
}

/** The `game` columns the walkthrough shows. */
export interface ReviewGameInput {
  id: string;
  userColor: Color;
  userResult: GameResult;
  opponentUsername: string;
  opponentRating?: number | null;
  playedAt: Date;
  timeControl: string;
  eco?: string | null;
  ecoUrl?: string | null;
  finalFen?: string | null;
}

export interface ReviewMove {
  ply: number;
  /** Full move number, taken from the FEN so a game from a set-up position still numbers. */
  moveNumber: number;
  color: Color;
  /** `21.` for White, `21...` for Black. */
  label: string;
  san: string;
  uci: string;
  fenBefore: string;
  fenAfter: string;
  /** Evaluation of the position the mover faced. Null on ply 1: nothing preceded it. */
  evalBefore: Evaluation | null;
  /** Evaluation after the move. Null when the game has not been analysed. */
  evalAfter: Evaluation | null;
  centipawnLoss: number;
  winPercentLoss: number;
  classification: Classification;
  phase: Phase;
  isCritical: boolean;
  /** True when this is a move by the player being coached. */
  byPlayer: boolean;
  bestMoveUci: string | null;
  bestMoveSan: string | null;
  /** The engine's principal variation, in SAN, from the position before the move. */
  bestLineSan: string[];
  clockMs: number | null;
  /** Engine-derived and deterministic. Never model output. */
  annotation: string;
}

export type KeyMomentReason =
  | 'turning-point'
  | 'blunder'
  | 'mistake'
  | 'inaccuracy'
  | 'critical';

export interface KeyMoment {
  ply: number;
  reason: KeyMomentReason;
  /** How much this moment is worth explaining. Higher first. */
  weight: number;
}

/** A run of consecutive plies in the same phase — a chapter of the walkthrough. */
export interface ReviewChapter {
  phase: Phase;
  fromPly: number;
  toPly: number;
  /** Accuracy of the coached side over this run, or null if they had no move in it. */
  playerAccuracy: number | null;
  playerBlunders: number;
}

export interface GameReview {
  gameId: string;
  /** The side being coached. */
  perspective: Color;
  result: GameResult;
  opponentUsername: string;
  opponentRating: number | null;
  playedAt: Date;
  timeControl: string;
  eco: string | null;
  ecoUrl: string | null;
  /** False when no `move_analysis` row was supplied: the board still walks, unannotated. */
  analysed: boolean;
  startFen: string;
  moves: ReviewMove[];
  chapters: ReviewChapter[];
  keyMoments: KeyMoment[];
  accuracy: { player: number | null; opponent: number | null };
}

export const STARTING_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

/** How many moments are worth spending a model call on. */
export const DEFAULT_KEY_MOMENT_LIMIT = 6;

/** How much a swing of the likely result adds to a moment's weight. */
const CRITICAL_BONUS = 25;

/** The coached player's own mistakes outrank their opponent's. It is their review. */
const PLAYER_WEIGHT = 1.5;

/** How many plies of the principal variation are worth showing. */
const MAX_PV_PLIES = 6;

const CLASSIFICATION_LABEL: Record<Classification, string> = {
  blunder: 'Blunder',
  mistake: 'Mistake',
  inaccuracy: 'Inaccuracy',
  good: 'Good move',
};

/** `+1.9`, `-0.4`, `M5`, `-M3`, or `?` when the position was never evaluated. */
export function formatEvaluation(evaluation: Evaluation | null): string {
  if (evaluation === null) return '?';
  if (evaluation.mateIn !== null) {
    return evaluation.mateIn >= 0 ? `M${evaluation.mateIn}` : `-M${Math.abs(evaluation.mateIn)}`;
  }
  if (evaluation.cp === null) return '?';
  const pawns = evaluation.cp / 100;
  return `${pawns >= 0 ? '+' : '-'}${Math.abs(pawns).toFixed(1)}`;
}

/** Win percentage for White in this position, for the eval bar. */
export function winPercentOf(evaluation: Evaluation | null): number | null {
  if (evaluation === null) return null;
  if (evaluation.cp === null && evaluation.mateIn === null) return null;
  return winPercent(centipawnsFor(evaluation));
}

export function moveLabel(moveNumber: number, color: Color): string {
  return color === 'w' ? `${moveNumber}.` : `${moveNumber}...`;
}

/** Full move number from a FEN, falling back to counting plies from the standard start. */
function moveNumberFrom(fen: string, ply: number): number {
  const field = fen.split(' ')[5];
  const parsed = field === undefined ? Number.NaN : Number.parseInt(field, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : Math.floor((ply - 1) / 2) + 1;
}

/** A UCI move rendered in SAN from `fen`, or null when it is not legal there. */
export function uciToSan(fen: string, uci: string | null): string | null {
  if (!uci || uci.length < 4) return null;
  try {
    const board = new Chess(fen);
    const played = board.move({
      from: uci.slice(0, 2),
      to: uci.slice(2, 4),
      promotion: uci.length > 4 ? uci.slice(4, 5) : undefined,
    });
    return played.san;
  } catch {
    return null;
  }
}

/** A UCI principal variation rendered in SAN, stopping at the first move that will not play. */
export function pvToSan(fen: string, pv: readonly string[] | null | undefined, max = MAX_PV_PLIES): string[] {
  if (!pv || pv.length === 0) return [];
  const board = new Chess(fen);
  const line: string[] = [];
  for (const uci of pv.slice(0, max)) {
    if (uci.length < 4) break;
    try {
      const played = board.move({
        from: uci.slice(0, 2),
        to: uci.slice(2, 4),
        promotion: uci.length > 4 ? uci.slice(4, 5) : undefined,
      });
      line.push(played.san);
    } catch {
      break;
    }
  }
  return line;
}

/** The position after `san` is played from `fen`, or `fen` again when it will not play. */
function applySan(fen: string, san: string): string {
  try {
    const board = new Chess(fen);
    board.move(san);
    return board.fen();
  } catch {
    return fen;
  }
}

/**
 * The one-line factual annotation every ply carries.
 *
 * It states what the engine found and nothing else: no advice, no speculation about intent.
 * The coach's prose is layered on top of this for key moments only.
 */
export function describeMove(
  move: Pick<
    ReviewMove,
    | 'classification'
    | 'winPercentLoss'
    | 'evalBefore'
    | 'evalAfter'
    | 'san'
    | 'bestMoveSan'
    | 'isCritical'
    | 'moveNumber'
    | 'color'
  >,
  analysed: boolean,
): string {
  if (!analysed) return 'Not analysed yet.';

  const parts: string[] = [];

  if (move.classification === 'good') {
    parts.push(move.bestMoveSan === move.san ? 'Best move.' : 'Good move.');
  } else {
    parts.push(
      `${CLASSIFICATION_LABEL[move.classification]}: -${Math.round(move.winPercentLoss)}% win chance.`,
    );
  }

  if (move.evalBefore !== null && move.evalAfter !== null) {
    parts.push(`Eval ${formatEvaluation(move.evalBefore)} → ${formatEvaluation(move.evalAfter)}.`);
  } else if (move.evalAfter !== null) {
    parts.push(`Eval ${formatEvaluation(move.evalAfter)}.`);
  }

  if (move.bestMoveSan !== null && move.bestMoveSan !== move.san) {
    parts.push(`Engine: ${moveLabel(move.moveNumber, move.color)}${move.bestMoveSan}.`);
  }

  if (move.isCritical) parts.push('Critical moment.');

  return parts.join(' ');
}

/**
 * The plies worth spending prose on, ranked by how much of the result they moved.
 *
 * Returned in ply order so the walkthrough reads forwards, but selected by weight so a
 * six-moment budget is spent on the six moments that mattered.
 */
export function selectKeyMoments(
  moves: readonly ReviewMove[],
  options?: { limit?: number },
): KeyMoment[] {
  const limit = options?.limit ?? DEFAULT_KEY_MOMENT_LIMIT;
  if (limit <= 0) return [];

  const scored = moves
    .filter((move) => move.classification !== 'good' || move.isCritical)
    .map((move) => ({
      ply: move.ply,
      classification: move.classification,
      isCritical: move.isCritical,
      weight:
        (move.winPercentLoss + (move.isCritical ? CRITICAL_BONUS : 0)) *
        (move.byPlayer ? PLAYER_WEIGHT : 1),
    }))
    .sort((a, b) => b.weight - a.weight || a.ply - b.ply);

  const turningPointPly = scored[0]?.ply;

  return scored
    .slice(0, limit)
    .map((entry) => ({
      ply: entry.ply,
      reason:
        entry.ply === turningPointPly
          ? ('turning-point' as const)
          : entry.classification !== 'good'
            ? entry.classification
            : ('critical' as const),
      weight: entry.weight,
    }))
    .sort((a, b) => a.ply - b.ply);
}

/** Consecutive plies of the same phase, with the coached side's accuracy over each run. */
export function chaptersOf(moves: readonly ReviewMove[]): ReviewChapter[] {
  const chapters: ReviewChapter[] = [];

  for (const move of moves) {
    const current = chapters[chapters.length - 1];
    if (current === undefined || current.phase !== move.phase) {
      chapters.push({
        phase: move.phase,
        fromPly: move.ply,
        toPly: move.ply,
        playerAccuracy: null,
        playerBlunders: 0,
      });
    } else {
      current.toPly = move.ply;
    }
  }

  for (const chapter of chapters) {
    const inChapter = moves.filter(
      (move) => move.byPlayer && move.ply >= chapter.fromPly && move.ply <= chapter.toPly,
    );
    chapter.playerAccuracy = gameAccuracy(inChapter.map((move) => move.winPercentLoss));
    chapter.playerBlunders = inChapter.filter((move) => move.classification === 'blunder').length;
  }

  return chapters;
}

/**
 * Assemble the walkthrough.
 *
 * Analysis is optional: an ingested but not-yet-analysed game still produces a complete,
 * playable review with every move marked "not analysed yet", because the worker gets to a
 * freshly synced game minutes after the dashboard shows it.
 */
export function buildGameReview(input: {
  game: ReviewGameInput;
  moves: readonly ReviewMoveInput[];
  analysis?: readonly ReviewAnalysisInput[];
}): GameReview {
  const { game } = input;
  const ordered = [...input.moves].sort((a, b) => a.ply - b.ply);
  const byPly = new Map((input.analysis ?? []).map((row) => [row.ply, row]));
  const analysed = byPly.size > 0;

  const moves: ReviewMove[] = ordered.map((move, index) => {
    const row = byPly.get(move.ply);
    const previous = index > 0 ? byPly.get(ordered[index - 1]!.ply) : undefined;

    const evalAfter: Evaluation | null =
      row === undefined ? null : { cp: row.evalCp, mateIn: row.mateIn };
    const evalBefore: Evaluation | null =
      previous === undefined ? null : { cp: previous.evalCp, mateIn: previous.mateIn };

    const moveNumber = moveNumberFrom(move.fenBefore, move.ply);
    const bestMoveUci = row?.bestMoveUci ?? null;

    const base = {
      ply: move.ply,
      moveNumber,
      color: move.color,
      label: moveLabel(moveNumber, move.color),
      san: move.san,
      uci: move.uci,
      fenBefore: move.fenBefore,
      fenAfter: applySan(move.fenBefore, move.san),
      evalBefore,
      evalAfter,
      centipawnLoss: row?.centipawnLoss ?? 0,
      winPercentLoss: row?.winPercentLoss ?? 0,
      classification: row?.classification ?? ('good' as Classification),
      phase: row?.phase ?? phaseOf(move.fenBefore, move.ply),
      isCritical: row?.isCritical ?? false,
      byPlayer: move.color === game.userColor,
      bestMoveUci,
      bestMoveSan: uciToSan(move.fenBefore, bestMoveUci),
      bestLineSan: pvToSan(move.fenBefore, row?.pv),
      clockMs: move.clockMs ?? null,
    };

    return { ...base, annotation: describeMove(base, analysed) };
  });

  const playerMoves = moves.filter((move) => move.byPlayer);
  const opponentMoves = moves.filter((move) => !move.byPlayer);

  return {
    gameId: game.id,
    perspective: game.userColor,
    result: game.userResult,
    opponentUsername: game.opponentUsername,
    opponentRating: game.opponentRating ?? null,
    playedAt: game.playedAt,
    timeControl: game.timeControl,
    eco: game.eco ?? null,
    ecoUrl: game.ecoUrl ?? null,
    analysed,
    startFen: moves[0]?.fenBefore ?? STARTING_FEN,
    moves,
    chapters: chaptersOf(moves),
    keyMoments: analysed ? selectKeyMoments(moves) : [],
    accuracy: {
      player: analysed ? gameAccuracy(playerMoves.map((move) => move.winPercentLoss)) : null,
      opponent: analysed ? gameAccuracy(opponentMoves.map((move) => move.winPercentLoss)) : null,
    },
  };
}

/** The move at a ply, for the coach and the UI. */
export function moveAt(review: GameReview, ply: number): ReviewMove | null {
  return review.moves.find((move) => move.ply === ply) ?? null;
}
