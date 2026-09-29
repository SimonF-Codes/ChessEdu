import { Chess, type Move, type Square } from 'chess.js';

import {
  CENTRE,
  MINOR_HOME,
  PIECE_NAME,
  PIECE_VALUE,
  attackedBy,
  attackersOf,
  materialBalance,
  pawnContact,
  piecesOf,
  rays,
  walkRay,
} from './board';
import type { Detector, MoveContext, Motif } from './types';

/**
 * The tutor's vocabulary: one pure function per thing that can be true about a move.
 *
 * Two families (docs/adr/0008-computed-tutor-and-learn-mode.md):
 *
 * - **Positional** detectors read the board with chess.js. They say what a move *does* —
 *   develops, pins, strikes at a pawn — and never whether that is good.
 * - **Engine** detectors read the ply's stored facts. They are the only ones that say a move is
 *   good or forced, and every number they print is a stored one. With no facts they do not fire.
 *
 * Weights order what is worth saying first; `explainMove` keeps the heaviest three.
 */

/** A gap this large means every other move is clearly worse: the only good move. */
export const ONLY_MOVE_GAP_CP = 100;

/** A gap this small means the engine barely prefers it: one of several good moves. */
export const ONE_OF_SEVERAL_GAP_CP = 25;

/** "Wins material" needs the stored score to agree by at least this much, from the mover's side. */
export const WINS_MATERIAL_MIN_CP = 100;

/** How many of the mover's own next moves in the stored PV "prepares a break" looks at. */
export const PREPARES_WINDOW_MOVES = 2;

function pieceOn(ctx: MoveContext, square: Square): string {
  const piece = ctx.after.get(square);
  return piece ? `the ${PIECE_NAME[piece.type]} on ${square}` : square;
}

function motif(id: string, weight: number, text: string): Motif {
  return { id, weight, text };
}

/** Whether a move is a pawn break: a pawn stepping into contact with an enemy pawn, not taking. */
function breakTarget(position: Chess, move: Move): Square | null {
  if (move.piece !== 'p' || move.captured) return null;
  const after = new Chess(position.fen());
  after.move(move.san);
  return pawnContact(after, move.to, move.color);
}

// --- Positional ---------------------------------------------------------------------------

export const onlyLegalMove: Detector = (ctx) =>
  ctx.before.moves().length === 1 ? motif('only-legal', 100, 'the only legal move') : null;

export const checkmate: Detector = (ctx) =>
  ctx.after.isCheckmate() ? motif('checkmate', 100, 'checkmate') : null;

export const castles: Detector = (ctx) => {
  if (ctx.move.flags.includes('k')) {
    return motif(
      'castles',
      70,
      'castles kingside, taking the king out of the centre and bringing the rook toward it',
    );
  }
  if (ctx.move.flags.includes('q')) {
    return motif(
      'castles',
      70,
      'castles queenside, taking the king out of the centre and bringing the rook toward it',
    );
  }
  return null;
};

export const develops: Detector = (ctx) => {
  const { move } = ctx;
  if (move.piece !== 'n' && move.piece !== 'b') return null;
  if (!MINOR_HOME[move.color].includes(move.from)) return null;
  return motif('develops', 55, `develops the ${PIECE_NAME[move.piece]} to ${move.to}`);
};

export const occupiesCentre: Detector = (ctx) => {
  const { move } = ctx;
  if (!CENTRE.includes(move.to)) return null;
  return move.piece === 'p'
    ? motif('occupies-centre', 40, `puts a pawn on ${move.to}, in the centre`)
    : motif(
        'occupies-centre',
        40,
        `brings the ${PIECE_NAME[move.piece]} to ${move.to}, in the centre`,
      );
};

export const captures: Detector = (ctx) => {
  const { move, previous } = ctx;
  if (!move.captured) return null;
  if (previous?.captured && previous.to === move.to) {
    return motif('recaptures', 55, `recaptures on ${move.to}`);
  }
  // En passant takes a pawn that is not on the destination square; name it by what it is.
  const where = move.flags.includes('e') ? '' : ` on ${move.to}`;
  return motif('captures', 50, `takes the ${PIECE_NAME[move.captured]}${where}`);
};

export const givesCheck: Detector = (ctx) =>
  ctx.after.inCheck() && !ctx.after.isCheckmate() ? motif('check', 35, 'gives check') : null;

export const pawnBreak: Detector = (ctx) => {
  const target = breakTarget(ctx.before, ctx.move);
  if (!target) return null;
  return motif(
    'pawn-break',
    60,
    `a pawn break: the pawn on ${ctx.move.to} challenges ${pieceOn(ctx, target)}`,
  );
};

/**
 * Moving a piece out of the way lets a bishop, rook or queen behind it see further. Fires when
 * one of the mover's other long-range pieces gains at least two squares.
 */
export const opensLine: Detector = (ctx) => {
  const { move } = ctx;
  if (move.flags.includes('k') || move.flags.includes('q')) return null;

  let best: { square: Square; type: 'b' | 'r' | 'q'; gain: number } | null = null;
  for (const piece of piecesOf(ctx.before, move.color)) {
    if (piece.square === move.from) continue;
    if (piece.type !== 'b' && piece.type !== 'r' && piece.type !== 'q') continue;
    const gain =
      attackedBy(ctx.after, piece.square).length - attackedBy(ctx.before, piece.square).length;
    if (gain >= 2 && (!best || gain > best.gain))
      best = { square: piece.square, type: piece.type, gain };
  }
  if (!best) return null;
  const line = best.type === 'b' ? 'the diagonal' : best.type === 'r' ? 'a file' : 'a line';
  return motif(
    'opens-line',
    25,
    `opens ${line} for the ${PIECE_NAME[best.type]} on ${best.square}`,
  );
};

/**
 * Enemy pieces the moved piece now hits that are worth hitting: undefended, or worth more than
 * the attacker. The king is left to "gives check".
 */
function threatenedBy(ctx: MoveContext): Square[] {
  const { move, after } = ctx;
  const mover = after.get(move.to);
  if (!mover) return [];
  const already = new Set(ctx.before.get(move.from) ? attackedBy(ctx.before, move.from) : []);
  return attackedBy(after, move.to).filter((square) => {
    const target = after.get(square);
    if (!target || target.color === move.color || target.type === 'k') return false;
    // The same piece hitting the same target from its old square is not news.
    if (already.has(square)) return false;
    const defended = attackersOf(after, square, target.color).length > 0;
    return !defended || PIECE_VALUE[target.type] > PIECE_VALUE[mover.type];
  });
}

export const attacksPiece: Detector = (ctx) => {
  const targets = threatenedBy(ctx);
  if (targets.length === 0) return null;
  const [target] = targets.sort(
    (a, b) => PIECE_VALUE[ctx.after.get(b)!.type] - PIECE_VALUE[ctx.after.get(a)!.type],
  );
  return motif('attacks-piece', 45, `attacks ${pieceOn(ctx, target!)}`);
};

export const fork: Detector = (ctx) => {
  const targets = threatenedBy(ctx);
  const names = targets.map((square) => PIECE_NAME[ctx.after.get(square)!.type]);
  if (ctx.after.inCheck()) names.unshift('king');
  if (names.length < 2) return null;
  const listed =
    names.length === 2
      ? names.join(' and the ')
      : `${names.slice(0, -1).join(', the ')} and the ${names.at(-1)}`;
  return motif('fork', 80, `forks the ${listed}`);
};

/**
 * The moved piece lines up through an enemy piece onto its king, or onto something worth more:
 * the front piece cannot move without exposing what stands behind it.
 */
export const pin: Detector = (ctx) => {
  const { move, after } = ctx;
  const piece = after.get(move.to);
  if (!piece) return null;
  for (const direction of rays(piece.type)) {
    const path = walkRay(after, move.to, direction);
    const front = path.at(-1);
    const frontPiece = front ? after.get(front) : undefined;
    if (!front || !frontPiece || frontPiece.color === move.color || frontPiece.type === 'k')
      continue;
    const behind = walkRay(after, front, direction).at(-1);
    const backPiece = behind ? after.get(behind) : undefined;
    if (!backPiece || backPiece.color === move.color) continue;
    if (backPiece.type === 'k') {
      return motif('pin', 65, `pins ${pieceOn(ctx, front)} to the king`);
    }
    if (PIECE_VALUE[backPiece.type] > PIECE_VALUE[frontPiece.type]) {
      return motif('pin', 65, `pins ${pieceOn(ctx, front)} to the ${PIECE_NAME[backPiece.type]}`);
    }
  }
  return null;
};

/** A piece of the mover's that was attacked and undefended before the move, and is defended by the moved piece after it. */
export const defendsHanging: Detector = (ctx) => {
  const { move, before, after } = ctx;
  const enemy = move.color === 'w' ? 'b' : 'w';
  for (const piece of piecesOf(before, move.color)) {
    if (piece.square === move.from || piece.type === 'k') continue;
    const hanging =
      attackersOf(before, piece.square, enemy).length > 0 &&
      attackersOf(before, piece.square, move.color).length === 0;
    if (!hanging) continue;
    if (attackedBy(after, move.to).includes(piece.square)) {
      return motif('defends', 50, `defends ${pieceOn(ctx, piece.square)}`);
    }
  }
  return null;
};

// --- Engine -------------------------------------------------------------------------------

export const onlyMove: Detector = (ctx) => {
  const gap = ctx.facts?.gapCp;
  if (gap === null || gap === undefined || gap < ONLY_MOVE_GAP_CP) return null;
  return motif(
    'only-move',
    90,
    `the engine's only good move here: its next best is ${gap} centipawns worse`,
  );
};

export const oneOfSeveral: Detector = (ctx) => {
  const gap = ctx.facts?.gapCp;
  if (gap === null || gap === undefined || gap < 0 || gap > ONE_OF_SEVERAL_GAP_CP) return null;
  return motif(
    'one-of-several',
    20,
    gap === 0
      ? 'one of several good moves: the engine rates another just as highly'
      : `one of several good moves: the engine's next best is only ${gap} centipawns behind`,
  );
};

export const behindBest: Detector = (ctx) => {
  const gap = ctx.facts?.gapCp;
  if (gap === null || gap === undefined || gap >= 0) return null;
  return motif(
    'behind-best',
    40,
    `not the engine's first choice: ${-gap} centipawns behind its best, close enough to be worth meeting`,
  );
};

/** Plays the stored PV on from the position after the move, stopping at anything illegal. */
function playOut(ctx: MoveContext): { board: Chess; moves: Move[] } {
  const board = new Chess(ctx.after.fen());
  const moves: Move[] = [];
  for (const uci of ctx.facts?.pv ?? []) {
    try {
      moves.push(
        board.move({
          from: uci.slice(0, 2),
          to: uci.slice(2, 4),
          promotion: uci.slice(4) || undefined,
        }),
      );
    } catch {
      break;
    }
  }
  return { board, moves };
}

const MATERIAL_WORDS: Record<number, string> = { 1: 'a pawn', 2: 'two pawns', 3: 'a piece' };

/**
 * The engine's continuation ends with the mover ahead on material, and the stored score agrees.
 * Either alone is not enough: a PV cut off mid-exchange can look like a win, and a good score can
 * come from something other than material.
 */
export const winsMaterial: Detector = (ctx) => {
  const { facts, move } = ctx;
  if (!facts || facts.pv.length === 0) return null;
  const sign = move.color === 'w' ? 1 : -1;
  const agrees =
    facts.mateIn !== null
      ? sign * facts.mateIn > 0
      : facts.scoreCp !== null && sign * facts.scoreCp >= WINS_MATERIAL_MIN_CP;
  if (!agrees) return null;

  const { board } = playOut(ctx);
  const gain = materialBalance(board, move.color) - materialBalance(ctx.before, move.color);
  if (gain < 1) return null;
  const amount = MATERIAL_WORDS[gain] ?? 'material';
  return motif('wins-material', 75, `wins material: the engine's line comes out ${amount} up`);
};

/**
 * A pawn break by the mover appears in the stored PV within the mover's next few moves. The claim
 * is about the search output — "the engine's line follows up with d4" — not about intent.
 */
export const preparesBreak: Detector = (ctx) => {
  const { facts, move } = ctx;
  if (!facts || facts.pv.length === 0) return null;
  if (breakTarget(ctx.before, move)) return null; // It is the break; `pawnBreak` says so.

  // The mover's own moves are the odd indices: pv[0] is the opponent's reply.
  const window = facts.pv.slice(0, PREPARES_WINDOW_MOVES * 2);
  const board = new Chess(ctx.after.fen());
  for (const [index, uci] of window.entries()) {
    const position = new Chess(board.fen());
    let played: Move;
    try {
      played = board.move({
        from: uci.slice(0, 2),
        to: uci.slice(2, 4),
        promotion: uci.slice(4) || undefined,
      });
    } catch {
      return null;
    }
    if (index % 2 === 1 && breakTarget(position, played)) {
      const when = index === 1 ? 'next move' : 'the move after';
      const san = played.san.replace(/[+#]$/, '');
      return motif(
        'prepares-break',
        60,
        `prepares ${san}: the engine's line plays that pawn break ${when}`,
      );
    }
  }
  return null;
};

/** Every detector, in the order ties are broken. */
export const DETECTORS: readonly Detector[] = [
  checkmate,
  onlyLegalMove,
  onlyMove,
  fork,
  winsMaterial,
  castles,
  pin,
  pawnBreak,
  preparesBreak,
  develops,
  captures,
  defendsHanging,
  attacksPiece,
  behindBest,
  occupiesCentre,
  givesCheck,
  opensLine,
  oneOfSeveral,
];
