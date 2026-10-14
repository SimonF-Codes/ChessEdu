import { Chess } from 'chess.js';
import { describe, expect, it } from 'vitest';

import { buildBook, defaultBook, parseEcoTsv, positionKey } from './book';
import {
  type BranchRule,
  type FacedReplies,
  type LineSpec,
  type RankMoves,
  type RankedMove,
  FACED_MIN_GAMES,
  FACED_VETO_CP,
  LINE_DEPTH_PLIES,
  PLY_PV_LIMIT,
  PONZIANI,
  PONZIANI_BRANCHING,
  chooseReplies,
  generateLines,
  lineDepthFor,
  lineKey,
  moveScore,
  nameLine,
  plyFacts,
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
const flat: RankMoves = async (fen, count, only) =>
  new Chess(fen)
    .moves({ verbose: true })
    .filter((move) => !only || only.includes(uciOf(move)))
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

  it('adds a reply taken from the player’s games, like a branch', () => {
    const plies = pliesFor([...ROOT, 'a6', 'd4'], []).map((ply) =>
      ply.ply === 6 ? { ...ply, source: 'games' as const } : ply,
    );
    expect(nameLine(plies, TOY_BOOK, TOY).name).toBe('Toy Opening · 3...a6');
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

  it('never branches the learner: one engine move per White node, the runner-up only measured', async () => {
    const { rank, asked } = recording(flat);
    const lines = await generateLines(TOY, { book: TOY_BOOK, rankMoves: rank });

    // Two, not one: the second is what gapCp is measured against (ADR 0008). Only one is played.
    for (const [fen, count] of asked) {
      if (new Chess(fen).turn() === 'w') expect(count).toBe(2);
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
    // Past the rules Black plays the engine's one move, but a runner-up is still asked for.
    expect(new Set(blackCounts.filter(([move]) => move === 5).map(([, c]) => c))).toEqual(
      new Set([2]),
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

describe('plyFacts — the engine facts stored with a searched ply', () => {
  const pv = (...ucis: string[]) => ucis;

  it('keeps the score after the move from White’s perspective, whoever moved', () => {
    const white = plyFacts([{ uci: 'd2d4', scoreCp: 30, mateIn: null }], 'd2d4', 'w');
    expect(white).toMatchObject({ scoreCp: 30, mateIn: null });

    const black = plyFacts([{ uci: 'd7d5', scoreCp: 14, mateIn: null }], 'd7d5', 'b');
    expect(black).toMatchObject({ scoreCp: -14, mateIn: null });

    const mated = plyFacts([{ uci: 'd8h4', scoreCp: null, mateIn: 1 }], 'd8h4', 'b');
    expect(mated).toMatchObject({ scoreCp: null, mateIn: -1 });
  });

  it('measures the best move’s lead over the runner-up — what tells an only move from one of several', () => {
    const ranked = [
      { uci: 'd2d4', scoreCp: 120, mateIn: null },
      { uci: 'd1a4', scoreCp: -60, mateIn: null },
    ];
    expect(plyFacts(ranked, 'd2d4', 'w')!.gapCp).toBe(180);
  });

  it('gives a branch reply below the best a negative gap: how far behind the best it sits', () => {
    const ranked = [
      { uci: 'd7d5', scoreCp: 14, mateIn: null },
      { uci: 'g8f6', scoreCp: 7, mateIn: null },
      { uci: 'a7a6', scoreCp: -53, mateIn: null },
    ];
    expect(plyFacts(ranked, 'a7a6', 'b')!.gapCp).toBe(-67);
    expect(plyFacts(ranked, 'g8f6', 'b')!.gapCp).toBe(-7);
    expect(plyFacts(ranked, 'd7d5', 'b')!.gapCp).toBe(7);
  });

  it('has no gap with no runner-up to measure against, and none across a mate', () => {
    expect(plyFacts([{ uci: 'e1g1', scoreCp: 10, mateIn: null }], 'e1g1', 'w')!.gapCp).toBeNull();
    const mating = [
      { uci: 'd1h5', scoreCp: null, mateIn: 2 },
      { uci: 'g1f3', scoreCp: 40, mateIn: null },
    ];
    expect(plyFacts(mating, 'd1h5', 'w')!.gapCp).toBeNull();
  });

  it('stores the continuation after the move, not the move itself, capped', () => {
    const long = pv('d2d4', 'e5d4', 'c3d4', 'd7d5', 'e4e5', 'c8f5', 'b1c3', 'e7e6', 'f1d3');
    const facts = plyFacts([{ uci: 'd2d4', scoreCp: 30, mateIn: null, pv: long }], 'd2d4', 'w');
    expect(facts!.pv).toEqual(long.slice(1, 1 + PLY_PV_LIMIT));
    expect(PLY_PV_LIMIT).toBe(6);
  });

  it('stores an empty continuation when the engine gave none', () => {
    expect(plyFacts([{ uci: 'd2d4', scoreCp: 30, mateIn: null }], 'd2d4', 'w')!.pv).toEqual([]);
  });

  it('is null for a move the engine did not rank — there is nothing to store about it', () => {
    expect(plyFacts([{ uci: 'd2d4', scoreCp: 30, mateIn: null }], 'c2c4', 'w')).toBeNull();
  });
});

describe('generateLines — engine facts on every searched ply', () => {
  /** `flat`, but with a distinct score per rank and a principal variation that starts with the move. */
  const graded: RankMoves = async (fen, count) => {
    const board = new Chess(fen);
    return board
      .moves({ verbose: true })
      .slice(0, count)
      .map((move, index) => {
        board.move(move.san);
        const reply = board.moves({ verbose: true })[0];
        board.undo();
        return {
          uci: uciOf(move),
          scoreCp: 50 - index * 40,
          mateIn: null,
          pv: reply ? [uciOf(move), uciOf(reply)] : [uciOf(move)],
        };
      });
  };

  it('leaves the root without facts: it was never searched', async () => {
    const lines = await generateLines(TOY, { book: TOY_BOOK, rankMoves: graded });
    for (const line of lines) {
      expect(line.plies.slice(0, 5).every((p) => p.facts === null)).toBe(true);
    }
  });

  it('stores the score, gap and continuation on every ply after the root', async () => {
    const lines = await generateLines(TOY, { book: EMPTY_BOOK, rankMoves: graded });
    for (const line of lines) {
      for (const ply of line.plies.slice(5)) {
        expect(ply.facts).not.toBeNull();
        expect(ply.facts!.pv.length).toBeGreaterThan(0);
        expect(ply.facts!.gapCp).not.toBeNull();
      }
    }
    const [first] = lines;
    // White's engine move is the best of two: 50 against 10, from White's side.
    const white = first!.plies[6]!;
    expect(white.facts).toMatchObject({ scoreCp: 50, gapCp: 40 });
    // Black's branch replies are scored from Black's side, stored from White's.
    const black = lines.map((line) => line.plies[5]!);
    expect(black[0]!.facts).toMatchObject({ scoreCp: -50, gapCp: 40 });
    expect(black.find((p) => p.facts!.gapCp! < 0)).toBeDefined();
  });

  it('stores the same facts for the same node in every line that passes it', async () => {
    const lines = await generateLines(TOY, { book: EMPTY_BOOK, rankMoves: graded });
    const seen = new Map<string, unknown>();
    for (const line of lines) {
      for (const ply of line.plies) {
        const key = `${ply.fenBefore}|${ply.uci}`;
        if (seen.has(key)) expect(ply.facts).toEqual(seen.get(key));
        seen.set(key, ply.facts);
      }
    }
  });
});

describe('lineDepthFor', () => {
  it('ends every line on the learner’s move: 11 plies for White, 12 for Black', () => {
    expect(lineDepthFor('w')).toBe(LINE_DEPTH_PLIES);
    expect(lineDepthFor('b')).toBe(LINE_DEPTH_PLIES + 1);
  });
});

/** UCI for a SAN move from the position after `path`. */
function uciAt(path: readonly string[], san: string): string {
  const board = new Chess(fenAfter(path));
  return uciOf(board.move(san));
}

describe('chooseReplies — the player’s games first, the engine as a veto (ADR 0009)', () => {
  const rule: BranchRule = { maxReplies: 6, marginCp: 100 };
  const faced = (entries: [uci: string, games: number][]) => new Map(entries);

  it('puts the replies the player has faced first, most frequent first, whatever the engine prefers', () => {
    const chosen = chooseReplies({
      ranked: ranked([
        ['a', 0],
        ['b', -10],
        ['c', -20],
      ]),
      faced: faced([
        ['c', 30],
        ['b', 10],
      ]),
      rule,
    });
    expect(chosen).toEqual([
      { uci: 'c', measured: true },
      { uci: 'b', measured: true },
      { uci: 'a', measured: false },
    ]);
  });

  it(`vetoes a faced reply more than ${FACED_VETO_CP} cp worse than the engine’s best: a popular loss is not theory`, () => {
    const chosen = chooseReplies({
      ranked: ranked([
        ['best', 20],
        ['edge', 20 - FACED_VETO_CP],
        ['loses', 19 - FACED_VETO_CP],
      ]),
      faced: faced([
        ['loses', 90],
        ['edge', 40],
      ]),
      rule: { maxReplies: 2, marginCp: 0 },
    });
    expect(chosen.map((c) => c.uci)).toEqual(['edge', 'best']);
    expect(FACED_VETO_CP).toBe(150);
  });

  it('vetoes a faced reply that allows mate, however popular', () => {
    const chosen = chooseReplies({
      ranked: [
        { uci: 'best', scoreCp: 0, mateIn: null },
        { uci: 'blunder', scoreCp: null, mateIn: -2 },
      ],
      faced: faced([['blunder', 500]]),
      rule,
    });
    expect(chosen.map((c) => c.uci)).toEqual(['best']);
  });

  it(`ignores a reply faced fewer than ${FACED_MIN_GAMES} times — an anecdote, not a measurement`, () => {
    const chosen = chooseReplies({
      ranked: ranked([
        ['a', 0],
        ['rare', -10],
      ]),
      faced: faced([['rare', FACED_MIN_GAMES - 1]]),
      rule: { maxReplies: 1, marginCp: 100 },
    });
    expect(chosen).toEqual([{ uci: 'a', measured: false }]);
    expect(FACED_MIN_GAMES).toBe(5);
  });

  it('keeps the rule’s cap: the most frequent faced replies win the slots', () => {
    const chosen = chooseReplies({
      ranked: ranked([
        ['a', 0],
        ['b', 0],
        ['c', 0],
        ['d', 0],
      ]),
      faced: faced([
        ['a', 5],
        ['b', 50],
        ['c', 20],
        ['d', 10],
      ]),
      rule: { maxReplies: 3, marginCp: 100 },
    });
    expect(chosen.map((c) => c.uci)).toEqual(['b', 'c', 'd']);
  });

  it('fills the slots left with ADR 0007’s margin rule, which still bounds them', () => {
    const chosen = chooseReplies({
      ranked: ranked([
        ['a', 0],
        ['b', -30],
        ['c', -120],
        ['faced', -140],
      ]),
      faced: faced([['faced', 12]]),
      rule,
    });
    expect(chosen).toEqual([
      { uci: 'faced', measured: true },
      { uci: 'a', measured: false },
      { uci: 'b', measured: false },
    ]);
  });

  it('with no faced replies is exactly selectReplies', () => {
    const moves = ranked([
      ['a', 0],
      ['b', -30],
      ['c', -120],
    ]);
    expect(chooseReplies({ ranked: moves, faced: undefined, rule }).map((c) => c.uci)).toEqual(
      selectReplies(moves, rule),
    );
  });

  it('past the branching rules plays the most-faced reply that survives the veto, else the engine’s best', () => {
    const moves = ranked([
      ['a', 0],
      ['b', -40],
      ['c', -400],
    ]);
    expect(
      chooseReplies({
        ranked: moves,
        faced: faced([
          ['c', 90],
          ['b', 30],
        ]),
        rule: undefined,
      }),
    ).toEqual([{ uci: 'b', measured: true }]);
    expect(chooseReplies({ ranked: moves, faced: undefined, rule: undefined })).toEqual([
      { uci: 'a', measured: false },
    ]);
  });

  it('breaks a tie in frequency by the engine’s score, then by move', () => {
    const chosen = chooseReplies({
      ranked: ranked([
        ['c', -10],
        ['b', -10],
        ['a', 0],
      ]),
      faced: faced([
        ['c', 20],
        ['b', 20],
        ['a', 20],
      ]),
      rule,
    });
    expect(chosen.map((c) => c.uci)).toEqual(['a', 'b', 'c']);
  });

  it('does not choose a faced reply the engine has not scored — it cannot be vetted', () => {
    const chosen = chooseReplies({
      ranked: ranked([['a', 0]]),
      faced: faced([['unscored', 80]]),
      rule,
    });
    expect(chosen.map((c) => c.uci)).toEqual(['a']);
  });
});

describe('generateLines — opponent replies from the player’s games (ADR 0009)', () => {
  const AT_ROOT = positionKey(fenAfter(ROOT));
  const a6 = uciAt(ROOT, 'a6');
  const qg5 = uciAt(ROOT, 'Qg5');

  /** PONZIANI_ENGINE, plus a restricted search that scores the moves it is limited to. */
  const SCORES = new Map([
    [a6, -53],
    [qg5, -400],
  ]);
  const engine: RankMoves = async (fen, count, only) => {
    if (!only) return PONZIANI_ENGINE(fen, count);
    return only.map((uci) => ({ uci, scoreCp: SCORES.get(uci) ?? 0, mateIn: null }));
  };

  const facedAtRoot: FacedReplies = new Map([
    [
      AT_ROOT,
      new Map([
        [qg5, 50],
        [a6, 20],
      ]),
    ],
  ]);

  it('branches on what the player faced, vetted, then fills from the engine’s margin', async () => {
    const lines = await generateLines(TOY, {
      book: EMPTY_BOOK,
      rankMoves: engine,
      faced: facedAtRoot,
    });
    const first = [...new Set(lines.map((line) => line.plies[5]!.san))];
    // TOY caps the first decision at three: 3...a6 from the games, then d5 and Nf6 by margin.
    // 3...Qg5 was faced more often, but the engine has it four pawns down.
    expect(first).toEqual(['a6', 'd5', 'Nf6']);
    const sourceOf = (san: string) => lines.find((l) => l.plies[5]!.san === san)!.plies[5]!.source;
    expect(sourceOf('a6')).toBe('games');
    expect(sourceOf('d5')).toBe('branch');
  });

  it('scores the faced replies the engine’s own ranking did not reach with a restricted search', async () => {
    const asked: [string, number, readonly string[] | undefined][] = [];
    await generateLines(TOY, {
      book: EMPTY_BOOK,
      rankMoves: async (fen, count, only) => {
        asked.push([fen, count, only]);
        return engine(fen, count, only);
      },
      faced: facedAtRoot,
    });
    const restricted = asked.filter(([, , only]) => only);
    expect(restricted).toHaveLength(1);
    expect(positionKey(restricted[0]![0])).toBe(AT_ROOT);
    expect(new Set(restricted[0]![2])).toEqual(new Set([qg5, a6]));
  });

  it('stores facts for a faced reply from the restricted search', async () => {
    const lines = await generateLines(TOY, {
      book: EMPTY_BOOK,
      rankMoves: engine,
      faced: facedAtRoot,
    });
    const line = lines.find((l) => l.plies[5]!.san === 'a6')!;
    // Black's -53 is White's +53; the best other reply, 3...d5, is +14 for Black.
    expect(line.plies[5]!.facts).toMatchObject({ scoreCp: 53, gapCp: -67 });
  });

  it('builds a Black repertoire: the replies to 1.e4 d5 in the shape the games give', async () => {
    const root = ['e4', 'd5'];
    const counts: [string, number][] = [
      ['exd5', 104],
      ['e5', 82],
      ['Nc3', 54],
      ['Qf3', 22],
      ['d3', 20],
      ['Nf3', 3],
    ];
    const faced: FacedReplies = new Map([
      [positionKey(fenAfter(root)), new Map(counts.map(([san, n]) => [uciAt(root, san), n]))],
    ]);
    const spec: LineSpec = {
      family: 'scandinavian-defense-black',
      eco: 'B01',
      name: 'Scandinavian Defense',
      rootSan: root,
      learnerColor: 'b',
      depthPlies: lineDepthFor('b'),
      branching: [{ maxReplies: 6, marginCp: 100 }],
    };
    const lines = await generateLines(spec, { book: EMPTY_BOOK, rankMoves: flat, faced });

    const replies = [...new Set(lines.map((line) => line.plies[2]!.san))];
    expect(replies.slice(0, 5)).toEqual(['exd5', 'e5', 'Nc3', 'Qf3', 'd3']);
    // The sixth slot comes from the engine's margin: 2.Nf3 was met only three times.
    expect(replies).toHaveLength(6);
    for (const line of lines) {
      expect(line.plies).toHaveLength(12);
      expect(line.plies.at(-1)!.color).toBe('b');
      expect(line.learnerColor).toBe('b');
      expect(line.key.startsWith('b:')).toBe(true);
    }
  });

  it('plays a faced reply past the branching rules, instead of the engine’s', async () => {
    const atRoot = scripted({
      [ROOT.join(' ')]: [
        ['d5', 10],
        ['f6', 0],
      ],
    });
    const lines = await generateLines(
      { ...TOY, branching: [] },
      {
        book: EMPTY_BOOK,
        rankMoves: (fen, count, only) =>
          positionKey(fen) === AT_ROOT ? atRoot(fen, count, only) : flat(fen, count, only),
        faced: new Map([[AT_ROOT, new Map([[uciAt(ROOT, 'f6'), 7]])]]),
      },
    );
    expect(lines).toHaveLength(1);
    expect(lines[0]!.plies[5]).toMatchObject({ san: 'f6', source: 'games' });
  });
});
