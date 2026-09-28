import type { Color, Evaluation } from './classify';

/**
 * Parsing the UCI protocol. Pure string handling, kept apart from the plumbing that owns an
 * engine — apps/worker/src/engine.ts spawning a process, apps/web/lib/engine driving a Web
 * Worker — so the fiddly part is testable without an engine at either end, and so both ends
 * agree on what a score means.
 */

export interface EngineInfo {
  depth: number;
  /** Centipawns from the side-to-move perspective, or null on a forced mate. */
  scoreCp: number | null;
  /** Plies to mate from the side-to-move perspective. */
  mateIn: number | null;
  pv: string[];
  /** Which principal variation this is, 1 being the best. 1 when the engine runs a single line. */
  multipv: number;
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

  const multipvIndex = tokens.indexOf('multipv');
  const multipv = multipvIndex === -1 ? 1 : Number(tokens[multipvIndex + 1]);
  if (!Number.isInteger(multipv) || multipv < 1) return null;

  const pvIndex = tokens.indexOf('pv');
  const pv = pvIndex === -1 ? [] : tokens.slice(pvIndex + 1).filter(Boolean);

  return {
    depth,
    scoreCp: scoreType === 'cp' ? scoreValue : null,
    mateIn: scoreType === 'mate' ? scoreValue : null,
    pv,
    multipv,
  };
}

/**
 * The final line of each principal variation of a MultiPV search, best first.
 *
 * Stockfish reports every variation again at each depth; the last complete report for each index
 * is the answer. A variation that never names a move is dropped — it is not a move to rank.
 */
export function finalVariations(infos: readonly EngineInfo[]): EngineInfo[] {
  const byIndex = new Map<number, EngineInfo>();
  for (const info of infos) {
    const seen = byIndex.get(info.multipv);
    if (!seen || info.depth >= seen.depth) byIndex.set(info.multipv, info);
  }
  return [...byIndex.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, info]) => info)
    .filter((info) => info.pv.length > 0);
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

/** A UCI option and the value to set it to. Values are strings on the wire, always. */
export interface UciOption {
  name: string;
  value: string;
}

/**
 * Format a `setoption` line. Stockfish ignores a malformed one in silence — no error, no
 * acknowledgement, just an engine that quietly kept its old setting — so the formatting lives
 * in one tested place rather than in a template literal at each call site.
 */
export function setOptionCommand(option: UciOption): string {
  return `setoption name ${option.name} value ${option.value}`;
}

/** A move in the shape chess.js takes, from the four or five characters UCI uses. */
export interface UciMove {
  from: string;
  to: string;
  /** Present only on a promotion. */
  promotion?: string;
}

const UCI_MOVE = /^([a-h][1-8])([a-h][1-8])([qrbn])?$/;

/**
 * Read a move off the wire.
 *
 * Returns null rather than throwing on anything unrecognised — `(none)`, `0000`, a truncated
 * line — because the caller's answer is the same either way: do not play it.
 */
export function parseUciMove(uci: string): UciMove | null {
  const match = UCI_MOVE.exec(uci.trim());
  if (!match) return null;

  const [, from, to, promotion] = match;
  if (!from || !to) return null;
  return promotion ? { from, to, promotion } : { from, to };
}
