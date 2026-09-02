import { Chess } from 'chess.js';

import type { Color } from './classify';

/**
 * Normalising a Chess.com game into the shape the database stores.
 *
 * Pure and I/O-free: fetching is the worker's job (apps/worker/src/ingest), parsing is this.
 */

/** The fields we rely on from `/pub/player/{username}/games/{YYYY}/{MM}`. */
export interface ChessComGame {
  url: string;
  pgn: string;
  time_control: string;
  time_class: string;
  rated: boolean;
  rules: string;
  end_time: number;
  eco?: string;
  fen?: string;
  white: ChessComPlayer;
  black: ChessComPlayer;
}

export interface ChessComPlayer {
  username: string;
  rating: number;
  result: string;
  uuid?: string;
}

export type GameResult = 'win' | 'loss' | 'draw';

export interface NormalizedMove {
  /** 1-based, counting each half-move. */
  ply: number;
  color: Color;
  san: string;
  uci: string;
  /** Position before the move, so a stalled analysis can resume mid-game. */
  fenBefore: string;
  /** Clock left after the move, for time-trouble correlation. Null if the PGN has no clocks. */
  clockMs: number | null;
}

export interface NormalizedGame {
  platformGameId: string;
  url: string;
  playedAt: Date;
  timeControl: string;
  timeClass: string;
  rated: boolean;
  rules: string;
  eco: string | null;
  ecoUrl: string | null;
  whiteUsername: string;
  blackUsername: string;
  userColor: Color;
  userResult: GameResult;
  userRating: number;
  opponentUsername: string;
  opponentRating: number;
  moveCount: number;
  finalFen: string;
  pgn: string;
  moves: NormalizedMove[];
}

/** Chess.com termination codes that mean neither side won. */
const DRAW_RESULTS = new Set([
  'agreed',
  'repetition',
  'stalemate',
  'insufficient',
  '50move',
  'timevsinsufficient',
]);

/**
 * Map a Chess.com per-player result code to an outcome. Anything unrecognised is treated as a
 * loss rather than thrown away: Chess.com adds termination codes over time, and the codes it
 * adds are ways to lose.
 */
export function resultFor(raw: string): GameResult {
  if (raw === 'win') return 'win';
  if (DRAW_RESULTS.has(raw)) return 'draw';
  return 'loss';
}

/** `0:02:59.5` -> 179500. Null when the string is not a clock. */
export function parseClockToMs(clock: string): number | null {
  const match = /^(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)$/.exec(clock.trim());
  if (!match) return null;
  const hours = Number(match[1] ?? 0);
  const minutes = Number(match[2]);
  const seconds = Number(match[3]);
  return Math.round((hours * 3600 + minutes * 60 + seconds) * 1000);
}

export function parsePgnHeaders(pgn: string): Record<string, string> {
  const headers: Record<string, string> = {};
  const pattern = /^\[(\w+)\s+"([^"]*)"\]$/gm;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(pgn)) !== null) {
    headers[match[1]!] = match[2]!;
  }
  return headers;
}

/** Clock readings in move order, taken straight from the `[%clk ...]` comments. */
export function extractClocks(pgn: string): (number | null)[] {
  const clocks: (number | null)[] = [];
  const pattern = /\[%clk\s+([^\]]+)\]/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(pgn)) !== null) {
    clocks.push(parseClockToMs(match[1]!));
  }
  return clocks;
}

/**
 * SAN tokens in order. The movetext is stripped of comments, variations, NAGs, move numbers
 * and the result token, leaving only moves.
 */
export function extractSanMoves(pgn: string): string[] {
  const withoutHeaders = pgn.replace(/^\[.*\]$/gm, '');
  const cleaned = withoutHeaders
    .replace(/\{[^}]*\}/g, ' ')
    .replace(/\([^()]*\)/g, ' ')
    .replace(/\$\d+/g, ' ')
    .replace(/\d+\.(\.\.)?/g, ' ')
    .replace(/(1-0|0-1|1\/2-1\/2|\*)\s*$/g, ' ');

  return cleaned
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 0);
}

/**
 * The board a game starts from, and the ply its first recorded move occupies.
 *
 * Most games start from the initial position, but Chess.com daily and themed games can begin
 * from a set position: the PGN carries `[SetUp "1"]` with a `[FEN ...]` and the movetext picks
 * up mid-game (`3... c6 4. f3 ...`). Replaying those from the initial position throws on the
 * very first move.
 *
 * The ply offset matters as much as the board. A game resuming at move 3 with Black to play has
 * its first recorded move at ply 6, and `phaseOf` reads ply to decide whether a position is
 * still in the opening — numbering from 1 would file a middlegame under the opening.
 */
function startingPosition(headers: Record<string, string>): { board: Chess; firstPly: number } {
  // A FEN header without SetUp describes the final position on some exports, not the first.
  const fen = headers.SetUp === '1' ? headers.FEN : undefined;
  if (!fen) return { board: new Chess(), firstPly: 1 };

  try {
    const board = new Chess(fen);
    const parts = fen.split(/\s+/u);
    const sideToMove = parts[1] ?? 'w';
    const moveNumber = Number(parts[5] ?? '1');
    if (!Number.isFinite(moveNumber) || moveNumber < 1) return { board, firstPly: 1 };
    return { board, firstPly: (moveNumber - 1) * 2 + (sideToMove === 'b' ? 2 : 1) };
  } catch {
    // An unusable FEN is not worth losing the game over. The moves may still replay from the
    // start; if they do not, the caller gets a clear error from the move itself.
    return { board: new Chess(), firstPly: 1 };
  }
}

export function normalizeGame(game: ChessComGame, username: string): NormalizedGame {
  const wanted = username.toLowerCase();
  const isWhite = game.white.username.toLowerCase() === wanted;
  const isBlack = game.black.username.toLowerCase() === wanted;
  if (!isWhite && !isBlack) {
    throw new Error(
      `${username} did not play in ${game.url} (white: ${game.white.username}, black: ${game.black.username})`,
    );
  }

  const headers = parsePgnHeaders(game.pgn);
  const clocks = extractClocks(game.pgn);
  const sanMoves = extractSanMoves(game.pgn);

  const { board, firstPly } = startingPosition(headers);
  const moves: NormalizedMove[] = [];
  for (const [index, san] of sanMoves.entries()) {
    const fenBefore = board.fen();
    const played = board.move(san);
    moves.push({
      ply: firstPly + index,
      color: played.color as Color,
      san: played.san,
      uci: `${played.from}${played.to}${played.promotion ?? ''}`,
      fenBefore,
      clockMs: clocks[index] ?? null,
    });
  }

  const self = isWhite ? game.white : game.black;
  const opponent = isWhite ? game.black : game.white;

  return {
    platformGameId: game.url.split('/').filter(Boolean).pop() ?? game.url,
    url: game.url,
    playedAt: new Date(game.end_time * 1000),
    timeControl: game.time_control,
    timeClass: game.time_class,
    rated: game.rated,
    rules: game.rules,
    eco: headers.ECO ?? null,
    ecoUrl: headers.ECOUrl ?? game.eco ?? null,
    whiteUsername: game.white.username,
    blackUsername: game.black.username,
    userColor: isWhite ? 'w' : 'b',
    userResult: resultFor(self.result),
    userRating: self.rating,
    opponentUsername: opponent.username,
    opponentRating: opponent.rating,
    moveCount: moves.length,
    finalFen: game.fen ?? board.fen(),
    pgn: game.pgn,
    moves,
  };
}
