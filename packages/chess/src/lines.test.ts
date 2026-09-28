import { Chess } from 'chess.js';
import { describe, expect, it } from 'vitest';

import { buildBook, defaultBook, parseEcoTsv } from './book';
import {
  type ChooseMove,
  type LineSpec,
  LINE_BRANCH_DECISIONS,
  LINE_DEPTH_PLIES,
  PONZIANI,
  generateLines,
  lineKey,
} from './lines';

/**
 * A scripted engine: the first legal move in chess.js's own order, which is deterministic and
 * has no opinion. The walk is what is under test, not the engine.
 */
const firstLegal: ChooseMove = async (fen) => {
  const [move] = new Chess(fen).moves({ verbose: true });
  return move ? `${move.from}${move.to}${move.promotion ?? ''}` : null;
};

/** Records every position the engine is asked about, so tests can see who chose what. */
function recording(inner: ChooseMove = firstLegal): { choose: ChooseMove; asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    choose: async (fen) => {
      asked.push(fen);
      return inner(fen);
    },
  };
}

/** A small hand-written book: two named replies to the root, one of which branches again. */
const TOY_TSV = [
  'C44\tToy Opening\t1. e4 e5 2. Nf3 Nc6 3. c3',
  'C44\tToy Opening: Knight\t1. e4 e5 2. Nf3 Nc6 3. c3 Nf6',
  'C44\tToy Opening: Centre\t1. e4 e5 2. Nf3 Nc6 3. c3 d5',
  'C44\tToy Opening: Centre, Queen\t1. e4 e5 2. Nf3 Nc6 3. c3 d5 4. Qa4',
  'C44\tToy Opening: Centre, Queen, Bishop\t1. e4 e5 2. Nf3 Nc6 3. c3 d5 4. Qa4 Bd7',
  'C44\tToy Opening: Centre, Queen, Knight\t1. e4 e5 2. Nf3 Nc6 3. c3 d5 4. Qa4 Nf6',
  'C44\tToy Opening: Centre, Queen, Deep\t1. e4 e5 2. Nf3 Nc6 3. c3 d5 4. Qa4 Nf6 5. Nxe5 Bd6',
  'C44\tToy Opening: Centre, Queen, Deep\t1. e4 e5 2. Nf3 Nc6 3. c3 d5 4. Qa4 Nf6 5. Nxe5 Qd6',
].join('\n');

const TOY_BOOK = buildBook(parseEcoTsv(TOY_TSV));

const TOY: LineSpec = {
  family: 'toy',
  eco: 'C44',
  name: 'Toy Opening',
  rootSan: ['e4', 'e5', 'Nf3', 'Nc6', 'c3'],
  learnerColor: 'w',
  depthPlies: 11,
  branchDecisions: 2,
};

/** An engine that plays the toy book's White moves where it has one, and first-legal elsewhere. */
const queenEngine: ChooseMove = async (fen) => {
  const board = new Chess(fen);
  for (const san of ['Qa4', 'Nxe5']) {
    try {
      const move = board.move(san);
      return `${move.from}${move.to}${move.promotion ?? ''}`;
    } catch {
      // not legal here
    }
  }
  return firstLegal(fen);
};

const sanOf = (line: { plies: readonly { san: string }[] }) => line.plies.map((p) => p.san);

describe('the Ponziani spec', () => {
  it('is the C44 root 1.e4 e5 2.Nf3 Nc6 3.c3, learner as White', () => {
    expect(PONZIANI.rootSan).toEqual(['e4', 'e5', 'Nf3', 'Nc6', 'c3']);
    expect(PONZIANI.eco).toBe('C44');
    expect(PONZIANI.learnerColor).toBe('w');
  });

  it('uses the documented depth and branching (ADR 0006)', () => {
    expect(PONZIANI.depthPlies).toBe(LINE_DEPTH_PLIES);
    expect(LINE_DEPTH_PLIES).toBe(11);
    expect(PONZIANI.branchDecisions).toBe(LINE_BRANCH_DECISIONS);
    expect(LINE_BRANCH_DECISIONS).toBe(2);
  });

  it('is a named position in the vendored book', () => {
    const board = new Chess();
    for (const san of PONZIANI.rootSan) board.move(san);
    expect(defaultBook().get(board.fen())?.name).toBe('Ponziani Opening');
  });
});

describe('generateLines', () => {
  it('emits lines of exactly the fixed depth, each ending on the learner’s move', async () => {
    const lines = await generateLines(TOY, { book: TOY_BOOK, chooseMove: firstLegal });
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(line.plies).toHaveLength(11);
      expect(line.plies.at(-1)!.color).toBe('w');
    }
  });

  it('plays the root from the opening’s own definition, not the engine', async () => {
    const { choose, asked } = recording();
    const lines = await generateLines(TOY, { book: TOY_BOOK, chooseMove: choose });

    for (const line of lines) {
      expect(sanOf(line).slice(0, 5)).toEqual(['e4', 'e5', 'Nf3', 'Nc6', 'c3']);
      expect(line.plies.slice(0, 5).every((p) => p.source === 'opening')).toBe(true);
    }
    // The start position is never put to the engine: 1.e4 is the opening, not a choice.
    expect(asked.some((fen) => fen.startsWith('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR'))).toBe(
      false,
    );
  });

  it('branches on every book reply at Black’s first decision', async () => {
    const lines = await generateLines(TOY, { book: TOY_BOOK, chooseMove: firstLegal });
    const firstReplies = new Set(lines.map((line) => line.plies[5]!.san));
    expect(firstReplies).toEqual(new Set(['Nf6', 'd5']));
    expect(lines.every((line) => line.plies[5]!.source === 'book')).toBe(true);
  });

  it('asks the engine for every White move after the root', async () => {
    const lines = await generateLines(TOY, { book: TOY_BOOK, chooseMove: firstLegal });
    for (const line of lines) {
      for (const ply of line.plies.slice(5)) {
        if (ply.color === 'w') expect(ply.source).toBe('engine');
      }
    }
  });

  it('branches on the book at Black’s second decision too, when the engine walks into it', async () => {
    const lines = await generateLines(TOY, { book: TOY_BOOK, chooseMove: queenEngine });
    const queenLines = lines.filter((line) => sanOf(line).slice(5, 7).join(' ') === 'd5 Qa4');
    expect(new Set(queenLines.map((line) => line.plies[7]!.san))).toEqual(new Set(['Bd7', 'Nf6']));
    expect(queenLines.every((line) => line.plies[7]!.source === 'book')).toBe(true);
  });

  it('stops branching after the configured number of Black decisions — the engine plays on', async () => {
    const lines = await generateLines(TOY, { book: TOY_BOOK, chooseMove: queenEngine });
    // 3...d5 4.Qa4 Nf6 5.Nxe5: the book has two named replies here, but it is Black's third
    // decision, so exactly one line continues and its move is the engine's.
    const deep = lines.filter((line) => sanOf(line).slice(5, 9).join(' ') === 'd5 Qa4 Nf6 Nxe5');
    expect(deep).toHaveLength(1);
    expect(deep[0]!.plies[9]!.source).toBe('engine');
  });

  it('lets Black fall back to the engine where the book has nothing', async () => {
    const lines = await generateLines(TOY, { book: TOY_BOOK, chooseMove: firstLegal });
    const knight = lines.filter((line) => line.plies[5]!.san === 'Nf6');
    expect(knight).toHaveLength(1);
    expect(knight[0]!.plies[7]!.source).toBe('engine');
  });

  it('names each line after the deepest named position it passes through', async () => {
    const lines = await generateLines(TOY, { book: TOY_BOOK, chooseMove: queenEngine });
    const names = new Map(lines.map((line) => [sanOf(line).slice(5, 8).join(' '), line.name]));
    expect(names.get('d5 Qa4 Bd7')).toBe('Toy Opening: Centre, Queen, Bishop');
    expect(names.get('d5 Qa4 Nf6')).toBe('Toy Opening: Centre, Queen, Knight');
    expect(lines.every((line) => line.eco === 'C44')).toBe(true);
  });

  it('records SAN, UCI and the FEN before every ply, consistently', async () => {
    const [line] = await generateLines(TOY, { book: TOY_BOOK, chooseMove: firstLegal });
    const board = new Chess();
    line!.plies.forEach((ply, index) => {
      expect(ply.ply).toBe(index + 1);
      expect(ply.fenBefore).toBe(board.fen());
      expect(ply.color).toBe(board.turn());
      const move = board.move(ply.san);
      expect(`${move.from}${move.to}${move.promotion ?? ''}`).toBe(ply.uci);
    });
  });

  it('keys a line by the learner’s colour and its moves, so re-running is an upsert', async () => {
    const first = await generateLines(TOY, { book: TOY_BOOK, chooseMove: firstLegal });
    const second = await generateLines(TOY, { book: TOY_BOOK, chooseMove: firstLegal });
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

  it('asks the engine about each position once, however many lines share it', async () => {
    const { choose, asked } = recording(queenEngine);
    await generateLines(TOY, { book: TOY_BOOK, chooseMove: choose });
    expect(new Set(asked).size).toBe(asked.length);
  });

  it('refuses a depth that would end a line on the opponent’s move', async () => {
    await expect(
      generateLines({ ...TOY, depthPlies: 10 }, { book: TOY_BOOK, chooseMove: firstLegal }),
    ).rejects.toThrow(/learner/);
  });

  it('refuses a root that is not legal chess', async () => {
    await expect(
      generateLines({ ...TOY, rootSan: ['e4', 'e4'] }, { book: TOY_BOOK, chooseMove: firstLegal }),
    ).rejects.toThrow();
  });

  it('refuses an engine move that is not legal, rather than storing it', async () => {
    const liar: ChooseMove = async () => 'a1a8';
    await expect(generateLines(TOY, { book: TOY_BOOK, chooseMove: liar })).rejects.toThrow(
      /illegal/,
    );
  });

  it('ends a line early, and still on the learner’s move, if the game is over', async () => {
    // Fool's-mate-shaped: after 1.f3 e5 2.g4 Qh4# there is nothing left to play.
    const mate: LineSpec = {
      ...TOY,
      rootSan: ['f3'],
      depthPlies: 11,
      branchDecisions: 0,
    };
    const scripted: ChooseMove = async (fen) => {
      const board = new Chess(fen);
      const order = ['e5', 'g4', 'Qh4#'];
      for (const san of order) {
        try {
          const move = board.move(san);
          return `${move.from}${move.to}`;
        } catch {
          // next
        }
      }
      return firstLegal(fen);
    };
    const lines = await generateLines(mate, { book: TOY_BOOK, chooseMove: scripted });
    // The line would end on Black's mating move; it is trimmed back to White's last move.
    expect(lines).toHaveLength(1);
    expect(sanOf(lines[0]!)).toEqual(['f3', 'e5', 'g4']);
  });

  it('produces the five named first replies to the Ponziani from the real book', async () => {
    const lines = await generateLines(PONZIANI, { book: defaultBook(), chooseMove: firstLegal });
    const firstReplies = new Set(lines.map((line) => line.plies[5]!.san));
    expect(firstReplies).toEqual(new Set(['d5', 'Nf6', 'f5', 'Be7', 'Nge7']));
    expect(lines.every((line) => line.name.startsWith('Ponziani Opening'))).toBe(true);
  });
});
