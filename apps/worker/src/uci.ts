import type { Color, Evaluation } from '@chessedu/chess';

/**
 * Parsing the UCI protocol. Pure string handling, kept apart from the process plumbing in
 * engine.ts so the fiddly part is testable without spawning Stockfish.
 */

export interface EngineInfo {
  depth: number;
  /** Centipawns from the side-to-move perspective, or null on a forced mate. */
  scoreCp: number | null;
  /** Plies to mate from the side-to-move perspective. */
  mateIn: number | null;
  pv: string[];
}

/**
 * Read one `info` line. Returns null for lines that carry no usable score: bound-only lines
 * are provisional, and `currmove` lines are progress chatter.
 */
export function parseInfoLine(line: string): EngineInfo | null {
  if (!line.startsWith('info ')) return null;
  if (line.includes(' lowerbound') || line.includes(' upperbound')) return null;

  const tokens = line.split(/\s+/);
  const depthIndex = tokens.indexOf('depth');
  const scoreIndex = tokens.indexOf('score');
  if (depthIndex === -1 || scoreIndex === -1) return null;

  const depth = Number(tokens[depthIndex + 1]);
  const scoreType = tokens[scoreIndex + 1];
  const scoreValue = Number(tokens[scoreIndex + 2]);
  if (!Number.isFinite(depth) || !Number.isFinite(scoreValue)) return null;

  const pvIndex = tokens.indexOf('pv');
  const pv = pvIndex === -1 ? [] : tokens.slice(pvIndex + 1).filter(Boolean);

  return {
    depth,
    scoreCp: scoreType === 'cp' ? scoreValue : null,
    mateIn: scoreType === 'mate' ? scoreValue : null,
    pv,
  };
}

export function parseBestMove(line: string): string | null {
  if (!line.startsWith('bestmove')) return null;
  const move = line.split(/\s+/)[1];
  if (!move || move === '(none)') return null;
  return move;
}

/**
 * UCI scores are relative to the side to move. Everything downstream stores evaluations from
 * White's perspective, so Black-to-move scores are flipped here, once.
 */
export function toWhitePerspective(
  info: Pick<EngineInfo, 'scoreCp' | 'mateIn'>,
  sideToMove: Color,
): Evaluation {
  if (sideToMove === 'w') return { cp: info.scoreCp, mateIn: info.mateIn };
  return {
    cp: info.scoreCp === null ? null : -info.scoreCp || 0,
    mateIn: info.mateIn === null ? null : -info.mateIn || 0,
  };
}

/** Side to move, read out of a FEN. */
export function sideToMove(fen: string): Color {
  return fen.split(' ')[1] === 'b' ? 'b' : 'w';
}
