import { Chess } from 'chess.js';

import { type OpeningBook, positionKey } from './book';
import { plyLabel } from './line-drill';

/**
 * Generating drillable opening lines: a tree walked from a fixed root, emitted leaf by leaf.
 *
 * Who picks each move is the whole design (docs/adr/0006-opening-line-drill.md, amended by
 * docs/adr/0007-line-coverage-and-replay.md):
 *
 * - inside the root, the opening's own definition — `3.c3` *is* the Ponziani, whatever an engine
 *   thinks of it;
 * - the learner's move, always the engine's best — a repertoire has one answer per position;
 * - the opponent's move, at each of its first decisions, every reply the engine rates close to its
 *   best (`BranchRule`), and the engine's single best after that.
 *
 * The ECO book is not asked which replies exist. It only *names* a line once the walk has made it.
 * The engine is injected, so this stays pure and is tested with a scripted one. The model is not
 * involved at all.
 */

type Color = 'w' | 'b';

/** Ten plies is where recall stops paying; one more so the line ends on the learner's move. */
export const LINE_DEPTH_PLIES = 11;

/**
 * Where a ply's move came from, stored with it so a line can be audited.
 *
 * - `opening`: the root, the opening's definition.
 * - `engine`: the engine's single choice at that node.
 * - `branch`: one of several opponent replies the engine rated close enough to its best to drill.
 * - `book`: an ECO continuation. Lines generated before ADR 0007 branched on the book, and their
 *   stored plies still say so. No run produces it now.
 */
export type LineMoveSource = 'opening' | 'engine' | 'branch' | 'book';

/** The longest continuation stored per ply: the mover's next two moves and change (ADR 0008). */
export const PLY_PV_LIMIT = 6;

/**
 * What the engine's search said about a ply, kept so the tutor can explain it without searching
 * again (docs/adr/0008-computed-tutor-and-learn-mode.md). Every number the tutor states comes
 * from here.
 */
export interface PlyFacts {
  /** The evaluation after the move, White's perspective, like every stored evaluation. */
  scoreCp: number | null;
  mateIn: number | null;
  /** The engine's continuation after the move, in UCI, at most `PLY_PV_LIMIT` plies. */
  pv: string[];
  /**
   * This move's score minus the best *other* move's at the same node, from the mover's side.
   * Large and positive: the only good move. Near zero: one of several. Negative: a branch reply
   * that far behind the engine's first choice. Null with no runner-up, or across a mate score.
   */
  gapCp: number | null;
}

export interface LinePly {
  /** 1-based from the start position. */
  ply: number;
  color: Color;
  san: string;
  uci: string;
  fenBefore: string;
  source: LineMoveSource;
  /** Null on the root, which is never searched, and on lines stored before ADR 0008. */
  facts: PlyFacts | null;
}

/**
 * How the opponent branches at one of its decisions: every reply within `marginCp` of the
 * engine's best, best first, at most `maxReplies` of them. The best reply always qualifies.
 */
export interface BranchRule {
  maxReplies: number;
  marginCp: number;
}

export interface LineSpec {
  /** Groups the lines one run produces, so the next run can retire what it no longer emits. */
  family: string;
  eco: string;
  /** The name to use when a line never reaches a named position deeper than the root. */
  name: string;
  rootSan: readonly string[];
  learnerColor: Color;
  depthPlies: number;
  /**
   * One rule per opponent decision after the root, in order. Past the end of the list the
   * opponent plays the engine's single best move.
   */
  branching: readonly BranchRule[];
}

export interface GeneratedLine {
  key: string;
  family: string;
  eco: string;
  name: string;
  learnerColor: Color;
  plies: LinePly[];
}

/** One legal move and how the engine rates it, from the perspective of the side to move. */
export interface RankedMove {
  uci: string;
  scoreCp: number | null;
  mateIn: number | null;
  /** The principal variation, starting with this move. */
  pv?: readonly string[];
}

/**
 * The engine's `count` best moves for a position, best first, scored for the side to move — UCI
 * MultiPV. Fewer when the position has fewer legal moves; empty when it has none.
 */
export type RankMoves = (fen: string, count: number) => Promise<RankedMove[]>;

/**
 * The opponent's branching for the Ponziani (ADR 0007): up to six replies within a pawn of the
 * best at `3.c3`, up to three within half a pawn at the next decision, the engine's move after.
 */
export const PONZIANI_BRANCHING: readonly BranchRule[] = [
  { maxReplies: 6, marginCp: 100 },
  { maxReplies: 3, marginCp: 50 },
];

export const PONZIANI: LineSpec = {
  family: 'ponziani',
  eco: 'C44',
  name: 'Ponziani Opening',
  rootSan: ['e4', 'e5', 'Nf3', 'Nc6', 'c3'],
  learnerColor: 'w',
  depthPlies: LINE_DEPTH_PLIES,
  branching: PONZIANI_BRANCHING,
};

/** Moves asked of the engine at every node: the one played, and the one it is measured against. */
const MIN_RANKED = 2;

/** Far outside any centipawn score, so every mate sorts beyond every material edge. */
const MATE_SCORE = 100_000;

/**
 * One number to compare moves by, for the side to move. Mating sooner beats mating later, being
 * mated later beats being mated sooner, and both lie beyond any centipawn score.
 */
export function moveScore(move: Pick<RankedMove, 'scoreCp' | 'mateIn'>): number {
  if (move.mateIn !== null) {
    return move.mateIn > 0 ? MATE_SCORE - move.mateIn : -MATE_SCORE - move.mateIn;
  }
  return move.scoreCp ?? 0;
}

/**
 * The opponent replies to drill at one node: those within the rule's margin of the best, best
 * first, capped. Ties keep the engine's order; the input is not trusted to be sorted.
 */
export function selectReplies(ranked: readonly RankedMove[], rule: BranchRule): string[] {
  if (ranked.length === 0 || rule.maxReplies < 1) return [];
  const scored = ranked
    .map((move, index) => ({ uci: move.uci, score: moveScore(move), index }))
    .sort((a, b) => b.score - a.score || a.index - b.index);
  const best = scored[0]!.score;
  return scored
    .filter((move) => best - move.score <= rule.marginCp)
    .slice(0, rule.maxReplies)
    .map((move) => move.uci);
}

/**
 * The facts to store with `uci`, played by `mover`, from the node's ranked moves. Null when the
 * engine did not rank that move. Scores arrive from the side to move and are stored from White's.
 */
export function plyFacts(
  ranked: readonly RankedMove[],
  uci: string,
  mover: Color,
): PlyFacts | null {
  const move = ranked.find((m) => m.uci === uci);
  if (!move) return null;

  const others = ranked.filter((m) => m.uci !== uci);
  const runnerUp = others.reduce<RankedMove | null>(
    (best, m) => (best === null || moveScore(m) > moveScore(best) ? m : best),
    null,
  );
  // A mate is not a distance in centipawns; saying "the next best is 99,980 worse" would be false.
  const gapCp =
    runnerUp && move.mateIn === null && runnerUp.mateIn === null
      ? (move.scoreCp ?? 0) - (runnerUp.scoreCp ?? 0)
      : null;

  const flip = (n: number | null): number | null => (n === null || mover === 'w' ? n : -n || 0);
  return {
    scoreCp: flip(move.scoreCp),
    mateIn: flip(move.mateIn),
    pv: (move.pv ?? []).slice(1, 1 + PLY_PV_LIMIT),
    gapCp,
  };
}

/**
 * A line's identity: the learner's colour and its moves. Transpositions are deliberately not
 * folded together — a line is drilled from move one, so its move order is what is learnt.
 */
export function lineKey(learnerColor: Color, ucis: readonly string[]): string {
  return `${learnerColor}:${ucis.join(' ')}`;
}

/**
 * Name a line: the deepest named book position it passes through, then the opponent's branch
 * choices made after that position — `Ponziani Opening · 3...a6` — so two lines that leave the
 * book at the same place are still told apart.
 */
export function nameLine(
  plies: readonly Pick<LinePly, 'ply' | 'san' | 'source'>[],
  book: OpeningBook,
  fallback: { eco: string; name: string },
): { eco: string; name: string } {
  let eco = fallback.eco;
  let name = fallback.name;
  let namedAt = 0;
  const walker = new Chess();
  for (const ply of plies) {
    walker.move(ply.san);
    const named = book.get(walker.fen());
    if (named?.eco && named.name) {
      eco = named.eco;
      name = named.name;
      namedAt = ply.ply;
    }
  }

  const choices = plies
    .filter((ply) => ply.source === 'branch' && ply.ply > namedAt)
    .map((ply) => plyLabel(ply.ply, ply.san));
  return { eco, name: choices.length > 0 ? `${name} · ${choices.join(', ')}` : name };
}

function uciOf(move: { from: string; to: string; promotion?: string }): string {
  return `${move.from}${move.to}${move.promotion ?? ''}`;
}

/** The side to move after `plies` half-moves from the start position. */
function colorAt(plies: number): Color {
  return plies % 2 === 0 ? 'w' : 'b';
}

/**
 * Walk the tree and return every line, in a stable order: depth first, the opponent's replies
 * best first. Each distinct position is put to the engine once per breadth asked of it.
 */
export async function generateLines(
  spec: LineSpec,
  deps: { book: OpeningBook; rankMoves: RankMoves },
): Promise<GeneratedLine[]> {
  if (colorAt(spec.depthPlies - 1) !== spec.learnerColor) {
    throw new Error(
      `a ${spec.depthPlies}-ply line would end on the opponent's move; lines end on the learner's`,
    );
  }

  // Validate the root up front: an illegal definition is a bug in the spec, not a short line.
  const probe = new Chess();
  for (const san of spec.rootSan) probe.move(san);

  const cache = new Map<string, Promise<RankedMove[]>>();
  const rank = (fen: string, count: number): Promise<RankedMove[]> => {
    const key = `${positionKey(fen)}|${count}`;
    let pending = cache.get(key);
    if (!pending) {
      pending = deps.rankMoves(fen, count);
      cache.set(key, pending);
    }
    return pending;
  };

  const lines: GeneratedLine[] = [];
  const board = new Chess();
  const plies: LinePly[] = [];

  const push = (uci: string, source: LineMoveSource, facts: PlyFacts | null): void => {
    const fenBefore = board.fen();
    let move;
    try {
      move = board.move({
        from: uci.slice(0, 2),
        to: uci.slice(2, 4),
        promotion: uci.slice(4) || undefined,
      });
    } catch {
      throw new Error(`illegal move ${uci} from ${source} in ${fenBefore}`);
    }
    plies.push({
      ply: plies.length + 1,
      color: move.color,
      san: move.san,
      uci: uciOf(move),
      fenBefore,
      source,
      facts,
    });
  };

  const pop = (): void => {
    board.undo();
    plies.pop();
  };

  const emit = (): void => {
    // A line ends on the learner's move; trim an opponent move left dangling by a game ending.
    let length = plies.length;
    while (length > 0 && plies[length - 1]!.color !== spec.learnerColor) length -= 1;
    const kept = plies
      .slice(0, length)
      .map((p) => ({ ...p, facts: p.facts && { ...p.facts, pv: [...p.facts.pv] } }));
    if (kept.length <= spec.rootSan.length) return;

    const { eco, name } = nameLine(kept, deps.book, spec);
    lines.push({
      key: lineKey(
        spec.learnerColor,
        kept.map((p) => p.uci),
      ),
      family: spec.family,
      eco,
      name,
      learnerColor: spec.learnerColor,
      plies: kept,
    });
  };

  const walk = async (opponentDecisions: number): Promise<void> => {
    if (plies.length >= spec.depthPlies || board.isGameOver()) {
      emit();
      return;
    }

    const index = plies.length;
    if (index < spec.rootSan.length) {
      const move = board.move(spec.rootSan[index]!);
      board.undo();
      push(uciOf(move), 'opening', null);
      await walk(opponentDecisions);
      pop();
      return;
    }

    // Every search asks for at least two moves, though White plays one: the runner-up's score is
    // what `gapCp` measures against, and it exists only inside this search (ADR 0008).
    const fen = board.fen();
    const mover = board.turn();
    if (mover === spec.learnerColor) {
      const ranked = await rank(fen, MIN_RANKED);
      const [best] = ranked;
      if (!best) return emit();
      push(best.uci, 'engine', plyFacts(ranked, best.uci, mover));
      await walk(opponentDecisions);
      pop();
      return;
    }

    const rule = spec.branching[opponentDecisions];
    const ranked = await rank(fen, Math.max(MIN_RANKED, rule?.maxReplies ?? 1));
    const replies = rule ? selectReplies(ranked, rule) : ranked.slice(0, 1).map((m) => m.uci);
    if (replies.length === 0) return emit();

    // A node where only the best reply survived the margin is not a branch; the engine chose.
    const source: LineMoveSource = replies.length > 1 ? 'branch' : 'engine';
    for (const uci of replies) {
      push(uci, source, plyFacts(ranked, uci, mover));
      await walk(opponentDecisions + 1);
      pop();
    }
  };

  await walk(0);
  return lines;
}
