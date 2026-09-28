import { Chess } from 'chess.js';
import { describe, expect, it } from 'vitest';

import { buildBook, defaultBook, parseEcoTsv } from './book';
import {
  type BranchRule,
  type LineSpec,
  type RankMoves,
  type RankedMove,
  LINE_DEPTH_PLIES,
  PONZIANI,
  PONZIANI_BRANCHING,
  generateLines,
  lineKey,
  moveScore,
  nameLine,
  selectReplies,
} from './lines';

const ROOT = ['e4', 'e5', 'Nf3', 'Nc6', 'c3'];

function uciOf(move: { from: string; to: string; promotion?: string }): string {
  return `${move.from}${move.to}${move.promotion ?? ''}`;
}

function fenAfter(sans: readonly string[]): string {
  const board = new Chess();
  for (const san of sans) board.move(san);
  return board.fen();
}

/**
 * A scripted engine with no opinion: every legal move in chess.js's own order, all scored level,
 * so a rule's cap alone decides how many survive. The walk is under test, not the engine.
 */
const flat: RankMoves = async (fen, count) =>
  new Chess(fen)
    .moves({ verbose: true })
    .slice(0, count)
    .map((move) => ({ uci: uciOf(move), scoreCp: 0, mateIn: null }));

/**
 * A scripted engine with opinions at named positions: `table` maps a SAN path to that position's
 * moves and scores, best first. Anywhere else it falls back to `flat`.
 */
function scripted(table: Record<string, [san: string, cp: number][]>): RankMoves {
  const byFen = new Map<string, [string, number][]>();
  for (const [path, moves] of Object.entries(table)) {
    byFen.set(fenAfter(path ? path.split(' ') : []), moves);
  }
  return async (fen, count) => {
    const moves = byFen.get(fen);
    if (!moves) return flat(fen, count);
    const board = new Chess(fen);
    return moves.slice(0, count).map(([san, cp]) => {
      const move = board.move(san);
      board.undo();
      return { uci: uciOf(move), scoreCp: cp, mateIn: null };
    });
  };
}

/** Records every question put to the engine. */
function recording(inner: RankMoves): { rank: RankMoves; asked: [string, number][] } {
  const asked: [string, number][] = [];
  return {
    asked,
    rank: async (fen, count) => {
      asked.push([fen, count]);
      return inner(fen, count);
    },
  };
}

/** Black's view at 3.c3 and after 3...d5 4.Qa4, roughly as Stockfish 17 sees them at depth 20. */
const PONZIANI_ENGINE = scripted({
  [ROOT.join(' ')]: [
    ['d5', 14],
    ['Nf6', 7],
    ['f5', -26],
    ['Nge7', -38],
    ['d6', -50],
    ['a6', -53],
    ['h6', -62],
    ['Be7', -65],
    ['Bc5', -88],
  ],
  [[...ROOT, 'd5', 'Qa4'].join(' ')]: [
    ['f6', 14],
    ['Bd7', 9],
    ['Qd6', 6],
    ['Nf6', -24],
    ['dxe4', -68],
  ],
  // White's reply to 3...d5: the engine's one answer.
  [[...ROOT, 'd5'].join(' ')]: [
    ['Qa4', 20],
    ['exd5', 15],
  ],
});

/** A small book, used only for names. */
const TOY_BOOK = buildBook(
  parseEcoTsv(
    [
      'C44\tToy Opening\t1. e4 e5 2. Nf3 Nc6 3. c3',
      'C44\tToy Opening: Centre\t1. e4 e5 2. Nf3 Nc6 3. c3 d5',
      'C44\tToy Opening: Centre, Queen\t1. e4 e5 2. Nf3 Nc6 3. c3 d5 4. Qa4',
      'C44\tToy Opening: Centre, Queen, Bishop\t1. e4 e5 2. Nf3 Nc6 3. c3 d5 4. Qa4 Bd7',
      'C44\tToy Opening: Fantasy\t1. e4 e5 2. Nf3 Nc6 3. c3 Qg5',
    ].join('\n'),
  ),
);

const EMPTY_BOOK = buildBook([]);

const TOY: LineSpec = {
  family: 'toy',
  eco: 'C44',
  name: 'Toy Opening',
  rootSan: ROOT,
  learnerColor: 'w',
  depthPlies: 11,
  branching: [
    { maxReplies: 3, marginCp: 100 },
    { maxReplies: 2, marginCp: 50 },
  ],
};

const sanOf = (line: { plies: readonly { san: string }[] }) => line.plies.map((p) => p.san);

const ranked = (moves: [uci: string, cp: number | null, mate?: number][]): RankedMove[] =>
  moves.map(([uci, scoreCp, mateIn]) => ({ uci, scoreCp, mateIn: mateIn ?? null }));

describe('moveScore', () => {
  it('is the centipawn score when there is one', () => {
    expect(moveScore({ scoreCp: -26, mateIn: null })).toBe(-26);
  });

  it('puts delivering mate above any material, and sooner above later', () => {
    const mateIn2 = moveScore({ scoreCp: null, mateIn: 2 });
    const mateIn5 = moveScore({ scoreCp: null, mateIn: 5 });
    expect(mateIn2).toBeGreaterThan(mateIn5);
    expect(mateIn5).toBeGreaterThan(5_000);
  });

  it('puts being mated below any material, and later above sooner', () => {
    const matedIn1 = moveScore({ scoreCp: null, mateIn: -1 });
    const matedIn6 = moveScore({ scoreCp: null, mateIn: -6 });
    expect(matedIn6).toBeGreaterThan(matedIn1);
    expect(matedIn6).toBeLessThan(-5_000);
  });
});

describe('selectReplies — which opponent replies a node branches on', () => {
  const RULE: BranchRule = { maxReplies: 3, marginCp: 50 };

  it('keeps every reply within the margin of the best, best first', () => {
    expect(
      selectReplies(
        ranked([
          ['d7d5', 14],
          ['g8f6', 7],
          ['f7f5', -26],
          ['g8e7', -38],
        ]),
        { maxReplies: 6, marginCp: 50 },
      ),
    ).toEqual(['d7d5', 'g8f6', 'f7f5']);
  });

  it('includes a reply exactly on the margin', () => {
    expect(
      selectReplies(
        ranked([
          ['a', 10],
          ['b', -40],
        ]),
        RULE,
      ),
    ).toEqual(['a', 'b']);
  });

  it('caps the number of replies however many are within the margin', () => {
    expect(
      selectReplies(
        ranked([
          ['a', 0],
          ['b', 0],
          ['c', 0],
          ['d', 0],
        ]),
        RULE,
      ),
    ).toEqual(['a', 'b', 'c']);
  });

  it('always keeps the best reply, even when nothing else is close', () => {
    expect(
      selectReplies(
        ranked([
          ['a', 300],
          ['b', 0],
        ]),
        RULE,
      ),
    ).toEqual(['a']);
  });

  it('does not trust the engine’s order — it sorts by score, ties in the order given', () => {
    expect(
      selectReplies(
        ranked([
          ['b', -10],
          ['a', 20],
          ['c', -10],
        ]),
        RULE,
      ),
    ).toEqual(['a', 'b', 'c']);
  });

  it('measures the margin from a mate like any other score — a forced mate admits no rival', () => {
    expect(
      selectReplies(
        ranked([
          ['mates', null, 3],
          ['wins-a-queen', 900],
        ]),
        RULE,
      ),
    ).toEqual(['mates']);
  });

  it('returns nothing when there are no moves or the cap is zero', () => {
    expect(selectReplies([], RULE)).toEqual([]);
    expect(selectReplies(ranked([['a', 0]]), { maxReplies: 0, marginCp: 50 })).toEqual([]);
  });
});

describe('nameLine', () => {
  const pliesFor = (sans: string[], branchAt: number[] = []) => {
    const board = new Chess();
    return sans.map((san, index) => {
      const fenBefore = board.fen();
      const move = board.move(san);
      const ply = index + 1;
      return {
        ply,
        color: move.color,
        san: move.san,
        uci: uciOf(move),
        fenBefore,
        source: branchAt.includes(ply) ? ('branch' as const) : ('engine' as const),
      };
    });
  };

  it('takes the deepest named position the line passes through', () => {
    const named = nameLine(pliesFor([...ROOT, 'd5', 'Qa4', 'Bd7', 'exd5'], [6, 8]), TOY_BOOK, TOY);
    expect(named).toEqual({ eco: 'C44', name: 'Toy Opening: Centre, Queen, Bishop' });
  });

  it('adds the branch choices made after the last named position, so lines stay distinct', () => {
    const named = nameLine(pliesFor([...ROOT, 'a6', 'd4', 'd6', 'dxe5'], [6, 8]), TOY_BOOK, TOY);
    expect(named.name).toBe('Toy Opening · 3...a6, 4...d6');
  });

  it('adds nothing for a move the engine chose alone', () => {
    const named = nameLine(pliesFor([...ROOT, 'a6', 'd4'], []), TOY_BOOK, TOY);
    expect(named.name).toBe('Toy Opening');
  });

  it('falls back to the spec when the book knows nothing', () => {
    expect(nameLine(pliesFor(ROOT), EMPTY_BOOK, TOY)).toEqual({ eco: 'C44', name: 'Toy Opening' });
  });
});

describe('the Ponziani spec', () => {
  it('is the C44 root 1.e4 e5 2.Nf3 Nc6 3.c3, learner as White', () => {
    expect(PONZIANI.rootSan).toEqual(ROOT);
    expect(PONZIANI.eco).toBe('C44');
    expect(PONZIANI.learnerColor).toBe('w');
  });

  it('uses the documented depth and branching (ADR 0006, ADR 0007)', () => {
    expect(PONZIANI.depthPlies).toBe(LINE_DEPTH_PLIES);
    expect(LINE_DEPTH_PLIES).toBe(11);
    expect(PONZIANI.branching).toBe(PONZIANI_BRANCHING);
    expect(PONZIANI_BRANCHING).toEqual([
      { maxReplies: 6, marginCp: 100 },
      { maxReplies: 3, marginCp: 50 },
    ]);
  });

  it('can produce at most 18 lines — the cap bounds the tree whatever the engine says', async () => {
    const lines = await generateLines(PONZIANI, { book: defaultBook(), rankMoves: flat });
    expect(lines).toHaveLength(18);
  });

  it('is a named position in the vendored book', () => {
    expect(defaultBook().get(fenAfter(ROOT))?.name).toBe('Ponziani Opening');
  });

  it('covers 3...d6 and 3...a6, which have no ECO name, and drops 3...Be7, which is too slow', async () => {
    const lines = await generateLines(PONZIANI, {
      book: defaultBook(),
      rankMoves: PONZIANI_ENGINE,
    });
    const firstReplies = new Set(lines.map((line) => line.plies[5]!.san));
    expect(firstReplies).toEqual(new Set(['d5', 'Nf6', 'f5', 'Nge7', 'd6', 'a6']));
    expect(lines.every((line) => line.name.startsWith('Ponziani Opening'))).toBe(true);
  });

  it('branches again after 3...d5 4.Qa4 on the three replies within half a pawn', async () => {
    const lines = await generateLines(PONZIANI, {
      book: defaultBook(),
      rankMoves: PONZIANI_ENGINE,
    });
    const queen = lines.filter((line) => sanOf(line).slice(5, 7).join(' ') === 'd5 Qa4');
    expect(queen.map((line) => line.plies[7]!.san)).toEqual(['f6', 'Bd7', 'Qd6']);
  });
});

describe('generateLines', () => {
  it('emits lines of exactly the fixed depth, each ending on the learner’s move', async () => {
    const lines = await generateLines(TOY, { book: TOY_BOOK, rankMoves: flat });
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(line.plies).toHaveLength(11);
      expect(line.plies.at(-1)!.color).toBe('w');
    }
  });

  it('plays the root from the opening’s own definition, not the engine', async () => {
    const { rank, asked } = recording(flat);
    const lines = await generateLines(TOY, { book: TOY_BOOK, rankMoves: rank });

    for (const line of lines) {
      expect(sanOf(line).slice(0, 5)).toEqual(ROOT);
      expect(line.plies.slice(0, 5).every((p) => p.source === 'opening')).toBe(true);
    }
    expect(asked.some(([fen]) => fen === new Chess().fen())).toBe(false);
  });

  it('never branches the learner: one engine move per White node, asked for exactly one', async () => {
    const { rank, asked } = recording(flat);
    const lines = await generateLines(TOY, { book: TOY_BOOK, rankMoves: rank });

    for (const [fen, count] of asked) {
      if (new Chess(fen).turn() === 'w') expect(count).toBe(1);
    }
    for (const line of lines) {
      for (const ply of line.plies.slice(5)) {
        if (ply.color === 'w') expect(ply.source).toBe('engine');
      }
    }
    // Every line sharing a position plays the same White move from it.
    const whiteMoveAt = new Map<string, string>();
    for (const line of lines) {
      for (const ply of line.plies.filter((p) => p.color === 'w')) {
        const seen = whiteMoveAt.get(ply.fenBefore);
        if (seen) expect(ply.uci).toBe(seen);
        whiteMoveAt.set(ply.fenBefore, ply.uci);
      }
    }
  });

  it('branches Black by the rule for each decision, and plays the engine’s move after the rules', async () => {
    const lines = await generateLines(TOY, { book: EMPTY_BOOK, rankMoves: flat });
    // 3 replies at the first decision, 2 at the second, 1 at the third: 6 lines.
    expect(lines).toHaveLength(6);
    expect(new Set(lines.map((line) => line.plies[5]!.uci)).size).toBe(3);
    for (const line of lines) {
      expect(line.plies[5]!.source).toBe('branch');
      expect(line.plies[7]!.source).toBe('branch');
      expect(line.plies[9]!.source).toBe('engine');
    }
  });

  it('asks the engine for as many candidates as the decision’s cap', async () => {
    const { rank, asked } = recording(flat);
    await generateLines(TOY, { book: EMPTY_BOOK, rankMoves: rank });
    const blackCounts = asked
      .filter(([fen]) => new Chess(fen).turn() === 'b')
      .map(([fen, count]) => [new Chess(fen).moveNumber(), count]);
    expect(new Set(blackCounts.filter(([move]) => move === 3).map(([, c]) => c))).toEqual(
      new Set([3]),
    );
    expect(new Set(blackCounts.filter(([move]) => move === 4).map(([, c]) => c))).toEqual(
      new Set([2]),
    );
    expect(new Set(blackCounts.filter(([move]) => move === 5).map(([, c]) => c))).toEqual(
      new Set([1]),
    );
  });

  it('does not take its branches from the ECO book — a book move the engine rejects is not played', async () => {
    // TOY_BOOK names 3...Qg5 and the engine rates it far below the best.
    const engine = scripted({
      [ROOT.join(' ')]: [
        ['d5', 10],
        ['Nf6', 0],
        ['Qg5', -400],
      ],
    });
    const lines = await generateLines(TOY, { book: TOY_BOOK, rankMoves: engine });
    const firstReplies = new Set(lines.map((line) => line.plies[5]!.san));
    expect(firstReplies).toEqual(new Set(['d5', 'Nf6']));
  });

  it('branches with no book at all — the book only names', async () => {
    const lines = await generateLines(TOY, { book: EMPTY_BOOK, rankMoves: PONZIANI_ENGINE });
    expect(new Set(lines.map((line) => line.plies[5]!.san))).toEqual(new Set(['d5', 'Nf6', 'f5']));
    expect(lines.every((line) => line.name.startsWith('Toy Opening · 3...'))).toBe(true);
  });

  it('marks a lone surviving reply as the engine’s, not a branch', async () => {
    const engine = scripted({
      [ROOT.join(' ')]: [
        ['d5', 300],
        ['Nf6', 0],
      ],
    });
    const lines = await generateLines(TOY, { book: EMPTY_BOOK, rankMoves: engine });
    expect(lines.every((line) => line.plies[5]!.san === 'd5')).toBe(true);
    expect(lines.every((line) => line.plies[5]!.source === 'engine')).toBe(true);
  });

  it('names each line after the deepest named position, plus the branches past it', async () => {
    const lines = await generateLines(TOY, { book: TOY_BOOK, rankMoves: PONZIANI_ENGINE });
    const names = new Map(lines.map((line) => [sanOf(line).slice(5, 8).join(' '), line.name]));
    expect(names.get('d5 Qa4 Bd7')).toBe('Toy Opening: Centre, Queen, Bishop');
    expect(names.get('d5 Qa4 f6')).toBe('Toy Opening: Centre, Queen · 4...f6');
    expect(lines.every((line) => line.eco === 'C44')).toBe(true);
  });

  it('records SAN, UCI and the FEN before every ply, consistently', async () => {
    const [line] = await generateLines(TOY, { book: TOY_BOOK, rankMoves: flat });
    const board = new Chess();
    line!.plies.forEach((ply, index) => {
      expect(ply.ply).toBe(index + 1);
      expect(ply.fenBefore).toBe(board.fen());
      expect(ply.color).toBe(board.turn());
      expect(uciOf(board.move(ply.san))).toBe(ply.uci);
    });
  });

  it('keys a line by the learner’s colour and its moves, so re-running is an upsert', async () => {
    const first = await generateLines(TOY, { book: TOY_BOOK, rankMoves: flat });
    const second = await generateLines(TOY, { book: TOY_BOOK, rankMoves: flat });
    expect(second.map((l) => l.key)).toEqual(first.map((l) => l.key));
    expect(new Set(first.map((l) => l.key)).size).toBe(first.length);
    expect(first[0]!.key).toBe(
      lineKey(
        'w',
        first[0]!.plies.map((p) => p.uci),
      ),
    );
    expect(first[0]!.key.startsWith('w:e2e4 e7e5 g1f3 b8c6 c2c3 ')).toBe(true);
  });

  it('asks the engine about each position once per breadth, however many lines share it', async () => {
    const { rank, asked } = recording(PONZIANI_ENGINE);
    await generateLines(TOY, { book: TOY_BOOK, rankMoves: rank });
    const keys = asked.map(([fen, count]) => `${fen}|${count}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('refuses a depth that would end a line on the opponent’s move', async () => {
    await expect(
      generateLines({ ...TOY, depthPlies: 10 }, { book: TOY_BOOK, rankMoves: flat }),
    ).rejects.toThrow(/learner/);
  });

  it('refuses a root that is not legal chess', async () => {
    await expect(
      generateLines({ ...TOY, rootSan: ['e4', 'e4'] }, { book: TOY_BOOK, rankMoves: flat }),
    ).rejects.toThrow();
  });

  it('refuses an engine move that is not legal, rather than storing it', async () => {
    const liar: RankMoves = async () => [{ uci: 'a1a8', scoreCp: 0, mateIn: null }];
    await expect(generateLines(TOY, { book: TOY_BOOK, rankMoves: liar })).rejects.toThrow(
      /illegal/,
    );
  });

  it('ends a line early, and still on the learner’s move, if the game is over', async () => {
    // Fool's-mate-shaped: after 1.f3 e5 2.g4 Qh4# there is nothing left to play.
    const mate: LineSpec = { ...TOY, rootSan: ['f3'], branching: [] };
    const engine = scripted({
      f3: [['e5', 0]],
      'f3 e5': [['g4', 0]],
      'f3 e5 g4': [['Qh4#', 0]],
    });
    const lines = await generateLines(mate, { book: TOY_BOOK, rankMoves: engine });
    // The line would end on Black's mating move; it is trimmed back to White's last move.
    expect(lines).toHaveLength(1);
    expect(sanOf(lines[0]!)).toEqual(['f3', 'e5', 'g4']);
  });
});
