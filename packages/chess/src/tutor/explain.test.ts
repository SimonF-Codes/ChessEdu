import { Chess } from 'chess.js';
import { describe, expect, it } from 'vitest';

import { defaultBook } from '../book';
import { PONZIANI, type PlyFacts, type RankMoves, generateLines } from '../lines';
import {
  MAX_MOTIFS,
  contextFor,
  describeSource,
  detectMotifs,
  explainMove,
  explainPly,
  formatScore,
  lineContext,
  sentence,
} from './explain';
import type { TutorLine } from './types';

function after(path: string, san: string, facts: PlyFacts | null = null) {
  const board = new Chess();
  let previous: { fenBefore: string; san: string } | null = null;
  for (const move of path.split(' ').filter(Boolean)) {
    previous = { fenBefore: board.fen(), san: move };
    board.move(move);
  }
  return contextFor({ fenBefore: board.fen(), san, previous, facts });
}

const ids = (motifs: { id: string }[]) => motifs.map((m) => m.id);

describe('explainMove', () => {
  it('says what 2.Nf3 does: develops, and attacks e5', () => {
    expect(ids(explainMove(after('e4 e5', 'Nf3')))).toEqual(['develops', 'attacks-piece']);
  });

  it(`keeps at most ${MAX_MOTIFS} clauses, heaviest first`, () => {
    const ctx = after('e4 e5 Nf3 Nc6 c3 Nf6', 'd4', {
      scoreCp: 30,
      mateIn: null,
      pv: ['e5d4', 'e4e5'],
      gapCp: 180,
    });
    expect(detectMotifs(ctx).length).toBeGreaterThan(MAX_MOTIFS);
    expect(ids(explainMove(ctx))).toEqual(['only-move', 'pawn-break', 'occupies-centre']);
  });

  it('drops a clause a heavier one already says: a fork is not also "gives check"', () => {
    const board = '4k3/8/8/1b6/8/8/8/3QK3 w - - 0 1';
    const found = ids(detectMotifs(contextFor({ fenBefore: board, san: 'Qe2+' })));
    expect(found).toContain('fork');
    expect(found).not.toContain('check');
    expect(found).not.toContain('attacks-piece');
  });

  it('says nothing about the engine without stored facts', () => {
    const found = ids(detectMotifs(after('e4 e5 Nf3 Nc6 c3 Nf6', 'd4')));
    expect(found).toContain('pawn-break');
    for (const id of [
      'only-move',
      'one-of-several',
      'behind-best',
      'wins-material',
      'prepares-break',
    ]) {
      expect(found).not.toContain(id);
    }
  });

  it('is deterministic: the same ply gets the same words every time', () => {
    const once = explainMove(after('e4 e5', 'Nf3'));
    const again = explainMove(after('e4 e5', 'Nf3'));
    expect(again).toEqual(once);
  });
});

describe('formatScore — only a stored score, as a person reads it', () => {
  const facts = (partial: Partial<PlyFacts>): PlyFacts => ({
    scoreCp: null,
    mateIn: null,
    pv: [],
    gapCp: null,
    ...partial,
  });

  it('formats centipawns as pawns, signed, White’s view', () => {
    expect(formatScore(facts({ scoreCp: 14 }))).toBe('+0.14');
    expect(formatScore(facts({ scoreCp: -120 }))).toBe('-1.20');
    expect(formatScore(facts({ scoreCp: 0 }))).toBe('0.00');
  });

  it('names who mates', () => {
    expect(formatScore(facts({ mateIn: 3 }))).toBe('White mates in 3');
    expect(formatScore(facts({ mateIn: -2 }))).toBe('Black mates in 2');
  });

  it('shows nothing without facts', () => {
    expect(formatScore(null)).toBeNull();
    expect(formatScore(undefined)).toBeNull();
  });
});

describe('describeSource — a branch reply and an engine move are told apart', () => {
  it('describes each source differently', () => {
    const texts = new Set([
      describeSource({ source: 'opening', color: 'w' }, 'w'),
      describeSource({ source: 'engine', color: 'w' }, 'w'),
      describeSource({ source: 'engine', color: 'b' }, 'w'),
      describeSource({ source: 'branch', color: 'b' }, 'w'),
      describeSource({ source: 'book', color: 'b' }, 'w'),
    ]);
    expect(texts.size).toBe(5);
  });

  it('calls the learner’s engine move the repertoire’s one answer', () => {
    expect(describeSource({ source: 'engine', color: 'w' }, 'w')).toMatch(/one answer/);
  });

  it('counts the branches when it knows them, and does not invent a count when it does not', () => {
    expect(describeSource({ source: 'branch', color: 'b' }, 'w', 6)).toMatch(/^One of 6 replies/);
    expect(describeSource({ source: 'branch', color: 'b' }, 'w')).toMatch(/^One of several/);
    expect(describeSource({ source: 'branch', color: 'b' }, 'w', 1)).toMatch(/^One of several/);
  });
});

describe('explainPly', () => {
  const line: TutorLine = {
    family: 'ponziani',
    learnerColor: 'w',
    plies: [],
  };

  it('labels the ply and shows the stored evaluation, or none on the root', async () => {
    const [generated] = await generateLines(PONZIANI, { book: defaultBook(), rankMoves: graded });
    const stored: TutorLine = { ...line, plies: generated!.plies };

    const root = explainPly(stored, 4);
    expect(root.label).toBe('3.c3');
    expect(root.evaluation).toBeNull();
    expect(root.source).toMatch(/opening's definition/);

    const reply = explainPly(stored, 5);
    expect(reply.label).toMatch(/^3\.\.\./);
    expect(reply.evaluation).not.toBeNull();
  });

  it('explains a line stored before facts existed, from the board alone', () => {
    const board = new Chess();
    const plies = ['e4', 'e5', 'Nf3'].map((san, index) => {
      const fenBefore = board.fen();
      const move = board.move(san);
      return {
        ply: index + 1,
        color: move.color,
        san,
        uci: `${move.from}${move.to}`,
        fenBefore,
        source: 'opening' as const,
      };
    });
    const explanation = explainPly({ ...line, plies }, 2);
    expect(explanation.evaluation).toBeNull();
    expect(ids(explanation.motifs)).toEqual(['develops', 'attacks-piece']);
  });
});

/**
 * An engine with opinions that vary by position, so gaps are real numbers of several sizes, and
 * a PV that starts with the move. Deterministic.
 */
const graded: RankMoves = async (fen, count) => {
  const board = new Chess(fen);
  return board
    .moves({ verbose: true })
    .slice(0, count)
    .map((move, index) => {
      board.move(move.san);
      const pv = [`${move.from}${move.to}`];
      for (const reply of board.moves({ verbose: true }).slice(0, 1))
        pv.push(`${reply.from}${reply.to}`);
      board.undo();
      return {
        uci: `${move.from}${move.to}`,
        scoreCp: 37 - index * (fen.length % 90),
        mateIn: null,
        pv,
      };
    });
};

describe('the §6 rule, checked over every ply of a generated Ponziani', () => {
  it('prints no number that is not a stored engine fact', async () => {
    const lines = await generateLines(PONZIANI, { book: defaultBook(), rankMoves: graded });
    expect(lines.length).toBeGreaterThan(0);

    let checked = 0;
    for (const generated of lines) {
      generated.plies.forEach((ply, index) => {
        const allowed = new Set<number>();
        if (ply.facts?.gapCp !== null && ply.facts?.gapCp !== undefined) {
          allowed.add(Math.abs(ply.facts.gapCp));
        }
        for (const motif of detectMotifs(lineContext(generated.plies, index))) {
          // Square names (`e4`) are coordinates, not claims; strip them and look at what is left.
          const numbers = motif.text.replace(/\b[a-h][1-8]\b/g, '').match(/\d+/g) ?? [];
          for (const number of numbers) {
            expect(allowed, `"${motif.text}" on ${ply.san}`).toContain(Number(number));
            checked += 1;
          }
        }
      });
    }
    // The generated lines must actually exercise the numeric clauses, or this proves nothing.
    expect(checked).toBeGreaterThan(0);
  });
});

describe('sentence', () => {
  it('capitalises a clause and ends it', () => {
    expect(sentence('develops the knight to f3')).toBe('Develops the knight to f3.');
    expect(sentence('Checkmate.')).toBe('Checkmate.');
  });
});
