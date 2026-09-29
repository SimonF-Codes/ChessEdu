import { Chess } from 'chess.js';
import { describe, expect, it } from 'vitest';

import { PONZIANI } from '../lines';
import { PENDING_REVIEW, TUTOR_LIBRARY, explainLine, plyNote } from './library';

function line(sans: string, family = 'ponziani') {
  return {
    family,
    plies: sans.split(' ').map((san, index) => ({ ply: index + 1, san })),
  };
}

const D5_BD7 = line('e4 e5 Nf3 Nc6 c3 d5 Qa4 Bd7 exd5 Nd4 Qd1');
const A6 = line('e4 e5 Nf3 Nc6 c3 a6 d4 d6 Bd3 Nf6 O-O');

/** Every authored string, with where it came from. */
function authored(): [where: string, text: string][] {
  return Object.values(TUTOR_LIBRARY).flatMap((notes) => [
    [`${notes.family} idea`, notes.idea] as [string, string],
    ...notes.rootNotes.map(
      (text, i) => [`${notes.family} root ${i + 1}`, text] as [string, string],
    ),
    ...notes.branches.map(
      (b) => [`${notes.family} ${b.after.join(' ')}`, b.note] as [string, string],
    ),
  ]);
}

describe('the authored library', () => {
  it('is marked as pending review until a person clears it', () => {
    expect(PENDING_REVIEW).toBe(true);
  });

  it('covers every root ply of the Ponziani — the engine never searched them', () => {
    const notes = TUTOR_LIBRARY[PONZIANI.family]!;
    expect(notes.rootSan).toEqual(PONZIANI.rootSan);
    expect(notes.rootNotes).toHaveLength(PONZIANI.rootSan.length);
    PONZIANI.rootSan.forEach((_, index) => {
      expect(plyNote(D5_BD7, index)).toBeTruthy();
    });
  });

  it('states no numbers: a digit may only be part of a move or a square', () => {
    for (const [where, text] of authored()) {
      const stripped = text
        .replace(/\b\d+\.(\.\.)?/g, '') // move numbers: 3. and 3...
        .replace(/[a-h][1-8]/g, ''); // squares, including inside SAN
      expect(stripped, where).not.toMatch(/\d/);
    }
  });

  it('asserts no evaluation in words either', () => {
    const verdicts =
      /\b(better|worse|best|winning|losing|equal|advantage|dubious|refut|mistake|blunder|strong|weak|good|bad|centipawn|usually|most players)\b/i;
    for (const [where, text] of authored()) {
      expect(text, where).not.toMatch(verdicts);
    }
  });

  it('keys every branch by a legal move sequence after the root', () => {
    for (const notes of Object.values(TUTOR_LIBRARY)) {
      for (const branch of notes.branches) {
        const board = new Chess();
        for (const san of [...notes.rootSan, ...branch.after]) {
          expect(() => board.move(san), `${branch.after.join(' ')}: ${san}`).not.toThrow();
        }
      }
    }
  });

  it('notes each of the six first replies ADR 0007 branches on', () => {
    const notes = TUTOR_LIBRARY[PONZIANI.family]!;
    const first = new Set(
      notes.branches.filter((b) => b.after.length === 1).map((b) => b.after[0]),
    );
    expect(first).toEqual(new Set(['d5', 'Nf6', 'f5', 'Nge7', 'd6', 'a6']));
  });
});

describe('explainLine', () => {
  it('gives the opening’s idea and every choice the line makes, in order', () => {
    const explanation = explainLine(D5_BD7);
    expect(explanation.kind).toBe('authored');
    if (explanation.kind !== 'authored') return;
    expect(explanation.idea).toMatch(/^The Ponziani/);
    expect(explanation.variations.map((v) => v.label)).toEqual(['3...d5', '4...Bd7']);
    expect(explanation.pendingReview).toBe(true);
  });

  it('gives the idea alone when the line’s choices have no notes', () => {
    const explanation = explainLine(line('e4 e5 Nf3 Nc6 c3 h6 d4'));
    expect(explanation).toMatchObject({ kind: 'authored', variations: [] });
  });

  it('is missing for a family with no notes', () => {
    expect(explainLine(line('d4 d5 c4', 'queens-gambit'))).toEqual({ kind: 'missing' });
  });

  it('is missing for a line that does not start as the family does', () => {
    expect(explainLine(line('e4 e5 Nf3 Nc6 Bb5 a6'))).toEqual({ kind: 'missing' });
  });
});

describe('plyNote', () => {
  it('returns the note for the root ply', () => {
    expect(plyNote(A6, 4)).toMatch(/^The Ponziani move/);
  });

  it('returns a branch note on the ply that makes the choice, and not on the plies after it', () => {
    expect(plyNote(A6, 5)).toMatch(/^A waiting move/);
    expect(plyNote(A6, 6)).toBeNull();
    expect(plyNote(D5_BD7, 7)).toMatch(/bishop between the queen and the king/);
  });

  it('returns null for a ply with no entry, an unknown family, or an index off the line', () => {
    expect(plyNote(line('e4 e5 Nf3 Nc6 c3 h6'), 5)).toBeNull();
    expect(plyNote(line('d4 d5', 'queens-gambit'), 0)).toBeNull();
    expect(plyNote(A6, 99)).toBeNull();
    expect(plyNote(A6, -1)).toBeNull();
  });
});
