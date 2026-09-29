import { Chess } from 'chess.js';
import { describe, expect, it } from 'vitest';

import { NOT_ANALYSED, askAboutMove, buildLineTree, movesStoredAt } from './boundary';
import type { TutorPly } from './types';

/**
 * The knowledge boundary: the tutor answers from the stored lines, and outside them says exactly
 * one thing. These are the tests that keep it from guessing.
 */

function plies(sans: string): TutorPly[] {
  const board = new Chess();
  return sans.split(' ').map((san, index) => {
    const fenBefore = board.fen();
    const move = board.move(san);
    return {
      ply: index + 1,
      color: move.color,
      san: move.san,
      uci: `${move.from}${move.to}${move.promotion ?? ''}`,
      fenBefore,
      source: index < 5 ? 'opening' : index === 5 ? 'branch' : 'engine',
      facts: null,
    };
  });
}

const D5 = { id: 'line-d5', name: 'Ponziani · 3...d5', plies: plies('e4 e5 Nf3 Nc6 c3 d5 Qa4') };
const NF6 = { id: 'line-nf6', name: 'Ponziani · 3...Nf6', plies: plies('e4 e5 Nf3 Nc6 c3 Nf6 d4') };
const A6 = { id: 'line-a6', name: 'Ponziani · 3...a6', plies: plies('e4 e5 Nf3 Nc6 c3 a6 d4') };
const TREE = buildLineTree([D5, NF6, A6]);

/** The position before ply `index` of a line. */
const before = (line: typeof D5, index: number) => line.plies[index]!.fenBefore;

describe('askAboutMove', () => {
  it('recognises the move this line plays', () => {
    expect(askAboutMove(TREE, { lineId: D5.id, fen: before(D5, 5), uci: 'd7d5' })).toEqual({
      kind: 'this-line',
      index: 5,
    });
  });

  it('recognises a move another stored line plays from here, and names that line', () => {
    const answer = askAboutMove(TREE, { lineId: D5.id, fen: before(D5, 5), uci: 'g8f6' });
    expect(answer).toMatchObject({
      kind: 'other-line',
      lineId: NF6.id,
      lineName: NF6.name,
      index: 5,
    });
  });

  it('says it has not analysed a legal move no stored line plays', () => {
    // 3...Bc5 is legal and ECO knows it; the stored lines do not play it.
    expect(askAboutMove(TREE, { lineId: D5.id, fen: before(D5, 5), uci: 'f8c5' })).toEqual({
      kind: 'not-analysed',
      text: NOT_ANALYSED,
    });
  });

  it('says it has not analysed anything from a position no stored line reaches', () => {
    const elsewhere = new Chess();
    elsewhere.move('d4');
    expect(askAboutMove(TREE, { lineId: D5.id, fen: elsewhere.fen(), uci: 'd7d5' }).kind).toBe(
      'not-analysed',
    );
  });

  it('does not match a move to a different position that happens to allow it', () => {
    // d2d4 is played from after 3...Nf6 and after 3...a6, never from after 3...d5.
    expect(askAboutMove(TREE, { lineId: D5.id, fen: before(D5, 6), uci: 'd2d4' }).kind).toBe(
      'not-analysed',
    );
  });

  it('answers in exactly one fixed sentence, which carries no evaluation', () => {
    expect(NOT_ANALYSED).toBe('I have not analysed that move.');
    expect(NOT_ANALYSED).not.toMatch(/\d/);
  });

  it('matches a position whatever its move counters say', () => {
    const fen = before(D5, 5).replace(/ \d+ \d+$/, ' 7 40');
    expect(askAboutMove(TREE, { lineId: D5.id, fen, uci: 'd7d5' }).kind).toBe('this-line');
  });
});

describe('movesStoredAt', () => {
  it('counts the replies the stored lines hold at a branch point', () => {
    expect(movesStoredAt(TREE, before(D5, 5))).toBe(3);
  });

  it('counts one move where every line agrees, and none off the tree', () => {
    expect(movesStoredAt(TREE, before(D5, 4))).toBe(1);
    expect(movesStoredAt(TREE, new Chess('8/8/8/8/8/8/8/K6k w - - 0 1').fen())).toBe(0);
  });
});
