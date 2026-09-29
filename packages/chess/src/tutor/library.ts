/**
 * ============================================================================================
 *  DRAFT — PENDING REVIEW BY A STRONGER PLAYER.
 *
 *  Every sentence below was drafted without a strong player checking it. A subtly wrong
 *  opening explanation is worse than none, so treat this file as unreviewed until Simon (or
 *  someone he trusts) has read it line by line and cleared `PENDING_REVIEW`. The Learn page
 *  says so on screen while it is set.
 * ============================================================================================
 *
 * The authored half of the tutor: why a *line* is played, in plain words. The motif detectors
 * say what a *move* does; this says what the player is trying to achieve.
 *
 * Rules for every entry (docs/architecture.md §6, docs/adr/0008-computed-tutor-and-learn-mode.md):
 *
 * - **Plans and ideas only.** "White prepares d4", "the bishop breaks the pin". Qualitative claims
 *   a reader can check against the board.
 * - **No evaluations.** No "better", "winning", "equal", "dubious", no centipawns, no
 *   percentages. Those belong to the engine, and the tutor reads them from stored facts. A test
 *   fails if a digit appears here other than in a move or a square.
 * - **No claims about frequency.** "Usually", "most players" — this file has no data for them.
 * - **Short.** A paragraph for the opening, a sentence or two per move.
 *
 * Keyed by family, then by the SAN moves *after the root*, so a reviewer reads
 * `['d5', 'Qa4', 'Bd7']` rather than a UCI key. A line or ply with no entry here shows the
 * motifs alone; that is the expected state for most plies, not an error.
 */

import { plyLabel } from '../line-drill';
import type { TutorPly } from './types';

/** Cleared by a human reviewer, never by code. The Learn page shows a draft notice while true. */
export const PENDING_REVIEW = true;

export interface BranchNote {
  /** SAN moves after the root, ending on the move this note is about. */
  after: readonly string[];
  note: string;
}

export interface OpeningNotes {
  family: string;
  name: string;
  /** The opening's defining moves, in SAN; the root plies' notes are in the same order. */
  rootSan: readonly string[];
  /** One paragraph: what the opening is trying to do. */
  idea: string;
  /** One note per root ply. The engine never searched these, so this is all the tutor has. */
  rootNotes: readonly string[];
  branches: readonly BranchNote[];
}

const PONZIANI_NOTES: OpeningNotes = {
  family: 'ponziani',
  name: 'Ponziani Opening',
  rootSan: ['e4', 'e5', 'Nf3', 'Nc6', 'c3'],
  idea:
    'The Ponziani is a fight for the centre. With 3.c3 White prepares d4, so that if Black ever ' +
    'takes on d4 the c-pawn can take back and White keeps two pawns side by side on e4 and d4. ' +
    "The pawn on c3 also opens a path for White's queen to a4 or b3, which is why the queen " +
    "comes out early in several of these lines. The price is that c3 is the square White's " +
    "queen's knight would normally use, and the move gives Black a moment to strike at the " +
    'centre first, most directly with ...d5 or ...Nf6.',
  rootNotes: [
    "White puts a pawn in the centre and opens lines for the queen and the king's bishop.",
    'Black answers in kind, putting a pawn in the centre to meet the one on e4.',
    'White develops a knight and attacks the pawn on e5 straight away.',
    'Black defends the pawn on e5 by developing a knight, which also keeps an eye on d4.',
    'The Ponziani move. White prepares d4: if Black then takes on d4, the c-pawn takes back and ' +
      'White keeps a pawn centre. It also clears the way for the queen to reach a4 or b3.',
  ],
  branches: [
    {
      after: ['d5'],
      note:
        'Black strikes at the centre at once, before White has time for d4, and the position ' +
        "opens quickly. With c3 played, White's queen can come to a4 and pin the knight on c6 " +
        'to the king.',
    },
    {
      after: ['d5', 'Qa4', 'Bd7'],
      note:
        'Black puts the bishop between the queen and the king. The knight on c6 is no longer ' +
        'pinned and is free to move again.',
    },
    {
      after: ['d5', 'Qa4', 'f6'],
      note:
        'Black props up the pawn on e5 with another pawn and keeps a firm centre. It takes the ' +
        "f6 square from the knight and loosens the squares around Black's king.",
    },
    {
      after: ['d5', 'Qa4', 'Qd6'],
      note: 'The queen steps to d6, where it guards the pawn on e5 and supports the pawn on d5.',
    },
    {
      after: ['Nf6'],
      note:
        'Black develops with an attack on the pawn on e4. With a pawn on c3, White cannot defend ' +
        'e4 with a knight from c3, so the fight over the centre starts straight away.',
    },
    {
      after: ['Nf6', 'd4', 'Nxe4'],
      note: 'Black takes the pawn on e4 rather than the one on d4, keeping the pawn on e5 for now.',
    },
    {
      after: ['Nf6', 'd4', 'exd4'],
      note:
        'Black exchanges on d4 and gives up the pawn on e5. This is the exchange that 3.c3 was ' +
        'played to meet.',
    },
    {
      after: ['Nf6', 'd4', 'd5'],
      note:
        'Black answers the central push with one of its own, leaving several pawns in contact ' +
        'in the middle of the board.',
    },
    {
      after: ['f5'],
      note:
        'A sharp reply. Black attacks the pawn on e4 with a pawn and aims to open the f-file, at ' +
        "the cost of loosening the squares around Black's own king.",
    },
    {
      after: ['f5', 'exf5', 'Qf6'],
      note:
        'The queen comes to f6, where it guards the pawn on e5 and eyes the pawn on f5, which ' +
        'Black wants back.',
    },
    {
      after: ['f5', 'exf5', 'e4'],
      note: "Instead of taking back on f5, Black pushes the e-pawn and chases White's knight from f3.",
    },
    {
      after: ['Nge7'],
      note:
        'A quiet reply. The knight goes to e7, from where it supports ...d5 later, though for now ' +
        "it blocks Black's king's bishop.",
    },
    {
      after: ['Nge7', 'Bc4', 'd5'],
      note: 'Black plays the ...d5 break that the knight on e7 was placed to support.',
    },
    {
      after: ['d6'],
      note:
        'Black holds the pawn on e5 with a pawn and keeps the position solid, but the pawn on d6 ' +
        "narrows the diagonal of Black's dark-squared bishop.",
    },
    {
      after: ['a6'],
      note:
        "A waiting move. It keeps a White bishop off b5 but does nothing for Black's centre, " +
        'which leaves White free to go ahead with the plan of d4.',
    },
  ],
};

/** Every opening the tutor has notes for, by family. */
export const TUTOR_LIBRARY: Readonly<Record<string, OpeningNotes>> = {
  [PONZIANI_NOTES.family]: PONZIANI_NOTES,
};

type LineLike = { family: string; plies: readonly Pick<TutorPly, 'ply' | 'san'>[] };

/** The family's notes, if the line starts with the opening they describe. */
function notesFor(line: LineLike): OpeningNotes | null {
  const notes = TUTOR_LIBRARY[line.family];
  if (!notes) return null;
  const starts = notes.rootSan.every((san, index) => line.plies[index]?.san === san);
  return starts ? notes : null;
}

export type LineExplanation =
  | {
      kind: 'authored';
      name: string;
      idea: string;
      /** Notes on the choices this line makes, in the order it makes them. */
      variations: { label: string; note: string }[];
      pendingReview: boolean;
    }
  /** No authored notes for this family, or a line that does not start as the family does. */
  | { kind: 'missing' };

/** What the library says about a whole line: the opening's idea, then each of its choices. */
export function explainLine(line: LineLike): LineExplanation {
  const notes = notesFor(line);
  if (!notes) return { kind: 'missing' };
  const rootLength = notes.rootSan.length;
  const after = line.plies.slice(rootLength).map((ply) => ply.san);

  const variations = notes.branches
    .filter((branch) => branch.after.every((san, index) => after[index] === san))
    .map((branch) => {
      const ply = line.plies[rootLength + branch.after.length - 1]!;
      return { label: plyLabel(ply.ply, ply.san), note: branch.note };
    });
  return {
    kind: 'authored',
    name: notes.name,
    idea: notes.idea,
    variations,
    pendingReview: PENDING_REVIEW,
  };
}

/** The authored note for one ply of a line, or null when there is none. */
export function plyNote(line: LineLike, index: number): string | null {
  const notes = notesFor(line);
  if (!notes || index < 0 || index >= line.plies.length) return null;
  const rootLength = notes.rootSan.length;
  if (index < rootLength) return notes.rootNotes[index] ?? null;

  const path = line.plies.slice(rootLength, index + 1).map((ply) => ply.san);
  const branch = notes.branches.find(
    (b) => b.after.length === path.length && b.after.every((san, i) => path[i] === san),
  );
  return branch?.note ?? null;
}
