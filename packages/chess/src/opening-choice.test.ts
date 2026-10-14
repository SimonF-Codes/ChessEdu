import { Chess } from 'chess.js';
import { describe, expect, it } from 'vitest';

import { LINE_DEPTH_PLIES, generateLines } from './lines';
import { buildBook } from './book';
import {
  DEFAULT_FAMILY_COUNT,
  FAMILY_BRANCHING,
  FAMILY_MIN_GAMES,
  type FamilyRecord,
  chooseOpenings,
  familyLabel,
  familyRoot,
  familySpec,
  familyStandings,
  foldFamilyRecords,
  lineFamilyId,
  lineFamilyLabel,
  openingFamily,
} from './opening-choice';

/** A family with no opening moves recorded: enough for the ranking, which reads only the totals. */
function record(
  color: 'w' | 'b',
  family: string,
  games: number,
  points: number,
  openings: FamilyRecord['openings'] = [],
): FamilyRecord {
  return { color, family, games, points, eco: null, openings };
}

/** Score as a share of the games, the way the design note gives it, back to half-points. */
const at = (games: number, pointsLost: number) => games * 0.5 - pointsLost;

/**
 * The real history on 2026-10-14, as `game` aggregates it (ADR 0009): every family on each side
 * with at least 40 games that the design note discusses, plus a few below the floor.
 */
const HISTORY: FamilyRecord[] = [
  record('b', 'Englund-Gambit', 55, at(55, 11.5)),
  record('b', 'Scandinavian-Defense', 318, at(318, 11)),
  record('b', 'Queens-Gambit', 68, at(68, 8)),
  record('b', 'Center-Game', 45, at(45, 8)),
  record('w', 'Sicilian-Defense', 79, at(79, 7)),
  record('w', 'Kings-Pawn-Opening-Kings-Knight-Variation', 126, at(126, 6.5)),
  record('b', 'Kings-Pawn-Opening', 147, at(147, 6)),
  record('w', 'Italian-Game', 77, at(77, 5)),
  record('w', 'French-Defense', 147, at(147, -9.5)),
  record('w', 'Nimzowitsch-Defense', 114, at(114, -15.5)),
  record('w', 'Ponziani-Opening', 4, 1),
  record('b', 'Latvian-Gambit', 12, 1),
];

describe('openingFamily — Chess.com’s opening name, cut to the decision', () => {
  it.each([
    ['Scandinavian-Defense-Mieses-Kotrc-Variation-3.Nc3', 'Scandinavian-Defense'],
    ['Scandinavian-Defense-2.e5', 'Scandinavian-Defense'],
    ['Queens-Gambit-Declined-Chigorin-Defense-3.e3', 'Queens-Gambit'],
    ['Englund-Gambit-2.dxe5', 'Englund-Gambit'],
    ['Englund-Gambit', 'Englund-Gambit'],
    [
      'Kings-Pawn-Opening-Kings-Knight-Variation-2...Nc6',
      'Kings-Pawn-Opening-Kings-Knight-Variation',
    ],
    ['Kings-Pawn-Opening-1...e5', 'Kings-Pawn-Opening'],
    ['Italian-Game-3...d6-4.O-O', 'Italian-Game'],
    [
      'Italian-Game-Two-Knights-Modern-Bishops-Opening-4...h6',
      'Italian-Game-Two-Knights-Modern-Bishops-Opening',
    ],
    ['Scandinavian-Defense-Closed...3.Nxe4-Bf5-4.Ng3-Bg6', 'Scandinavian-Defense'],
  ])('%s is %s', (slug, family) => {
    expect(openingFamily(`https://www.chess.com/openings/${slug}`)).toBe(family);
  });

  it('is null without an opening name', () => {
    expect(openingFamily(null)).toBeNull();
    expect(openingFamily('')).toBeNull();
    expect(openingFamily('https://www.chess.com/game/live/123')).toBeNull();
  });
});

describe('familyStandings — points lost, the ranking', () => {
  it('is games × (0.5 − score), with the score alongside', () => {
    const [englund] = familyStandings([record('b', 'Englund-Gambit', 55, 16)]);
    expect(englund).toMatchObject({ games: 55, points: 16, pointsLost: 11.5 });
    expect(englund!.score).toBeCloseTo(0.291, 3);
  });

  it(`ranks only families with at least ${FAMILY_MIN_GAMES} games — below that the score is noise`, () => {
    const standings = familyStandings([
      record('b', 'Thirty-Nine-Defense', 39, 0),
      record('b', 'Forty-Defense', 40, 19),
    ]);
    expect(standings.map((s) => s.family)).toEqual(['Forty-Defense']);
    expect(FAMILY_MIN_GAMES).toBe(40);
  });

  it('takes the floor as an option', () => {
    expect(familyStandings([record('b', 'Small-Defense', 10, 0)], { minGames: 10 })).toHaveLength(
      1,
    );
  });

  it('keeps strengths in the standings, at the bottom', () => {
    const standings = familyStandings(HISTORY);
    expect(standings.at(-1)).toMatchObject({ family: 'Nimzowitsch-Defense', pointsLost: -15.5 });
    expect(standings.at(-2)).toMatchObject({ family: 'French-Defense', pointsLost: -9.5 });
  });

  it('breaks a tie on points lost by more games first — the same cost on more evidence', () => {
    const standings = familyStandings([
      record('b', 'Center-Game', 45, at(45, 8)),
      record('b', 'Queens-Gambit', 68, at(68, 8)),
    ]);
    expect(standings.map((s) => s.family)).toEqual(['Queens-Gambit', 'Center-Game']);
  });

  it('breaks a full tie by side, then name, so the order never depends on the input’s', () => {
    const rows = [
      record('w', 'B-Defense', 50, 20),
      record('b', 'B-Defense', 50, 20),
      record('b', 'A-Defense', 50, 20),
    ];
    const expected = ['b A-Defense', 'b B-Defense', 'w B-Defense'];
    expect(familyStandings(rows).map((s) => `${s.color} ${s.family}`)).toEqual(expected);
    expect(familyStandings([...rows].reverse()).map((s) => `${s.color} ${s.family}`)).toEqual(
      expected,
    );
  });

  it('reproduces the verified ranking of the real history (ADR 0009)', () => {
    const top = familyStandings(HISTORY)
      .slice(0, 7)
      .map((s) => [s.color, s.family, s.games, Math.round(s.score * 1000) / 10, s.pointsLost]);
    expect(top).toEqual([
      ['b', 'Englund-Gambit', 55, 29.1, 11.5],
      ['b', 'Scandinavian-Defense', 318, 46.5, 11],
      ['b', 'Queens-Gambit', 68, 38.2, 8],
      ['b', 'Center-Game', 45, 32.2, 8],
      ['w', 'Sicilian-Defense', 79, 41.1, 7],
      ['w', 'Kings-Pawn-Opening-Kings-Knight-Variation', 126, 44.8, 6.5],
      ['b', 'Kings-Pawn-Opening', 147, 45.9, 6],
    ]);
  });
});

/** `games` games that all opened with `moves`, as the aggregation hands them over. */
const opened = (moves: string, games: number) => ({ sans: moves.split(' '), games });

describe('familyRoot — the moves that define a family', () => {
  it('stops at the first move that singles the family out of the player’s games', () => {
    const englund = record('b', 'Englund-Gambit', 55, 16, [
      opened('d4 e5 dxe5 Nc6 Nf3', 36),
      opened('d4 e5 Nf3 e4', 12),
      opened('d4 e5 e4 exd4', 7),
    ]);
    // 1.d4 is played in many Black games that are not the Englund; 1.d4 e5 is only the Englund.
    const queens = record('b', 'Queens-Gambit', 60, 20, [opened('d4 d5 c4 e6', 60)]);
    expect(familyRoot(englund, [englund, queens])).toEqual(['d4', 'e5']);
  });

  it('follows a transposition-heavy family to its defining move', () => {
    const queens = record('b', 'Queens-Gambit', 68, 26, [
      opened('d4 d5 c4 dxc4', 26),
      opened('d4 d5 c4 e6', 25),
      opened('d4 d5 e3 Nc6 c4', 10),
      opened('d4 d5 Nf3 Nf6 c4', 5),
      opened('c4 d5 cxd5 Qxd5', 2),
    ]);
    const others = record('b', 'Queens-Pawn-Opening', 300, 150, [
      opened('d4 d5 e3', 200),
      opened('d4 d5 Bf4', 93),
      opened('d4 d5 c4 c6', 7),
    ]);
    // 1.d4 d5 is mostly other families; 2.c4 is the Queen's Gambit 51 times in 58.
    expect(familyRoot(queens, [queens, others])).toEqual(['d4', 'd5', 'c4']);
  });

  it('never goes past where half the family’s games still agree', () => {
    // 2...Qf6 identifies the family, but only a third of its games play it.
    const knight = record('w', 'Kings-Pawn-Opening-Kings-Knight-Variation', 120, 54, [
      opened('e4 e5 Nf3 Qf6 Bc4', 40),
      opened('e4 e5 Nf3 d6 Bc4', 30),
      opened('e4 e5 Nf3 f6 Nxe5', 30),
      opened('e4 e5 Nf3 Bc5 Nxe5', 20),
    ]);
    const italian = record('w', 'Italian-Game', 400, 200, [opened('e4 e5 Nf3 Nc6 Bc4', 400)]);
    expect(familyRoot(knight, [knight, italian])).toEqual(['e4', 'e5', 'Nf3']);
  });

  it('counts only the player’s games on the family’s side', () => {
    const scandinavian = record('b', 'Scandinavian-Defense', 300, 140, [opened('e4 d5 exd5', 300)]);
    // As White the player meets 1...d5 in a different family's games — irrelevant to Black's root.
    const asWhite = record('w', 'Scandinavian-Defense', 900, 500, [opened('e4 d5 exd5', 900)]);
    const otherBlack = record('b', 'Kings-Pawn-Opening', 600, 300, [opened('e4 e5 Nf3', 600)]);
    expect(familyRoot(scandinavian, [scandinavian, asWhite, otherBlack])).toEqual(['e4', 'd5']);
  });

  it('is empty when the family has no recorded moves', () => {
    const bare = record('b', 'Englund-Gambit', 55, 16);
    expect(familyRoot(bare, [bare])).toEqual([]);
  });
});

describe('familySpec — a family as a LineSpec', () => {
  const englund: FamilyRecord = {
    ...record('b', 'Englund-Gambit', 55, 16, [opened('d4 e5 dxe5 Nc6', 55)]),
    eco: 'A40',
  };
  const others = record('b', 'Queens-Pawn-Opening', 300, 150, [opened('d4 d5 e3', 300)]);

  it('takes the root from the games and the learner from the side the player had', () => {
    const spec = familySpec(englund, [englund, others])!;
    expect(spec.rootSan).toEqual(['d4', 'e5']);
    expect(spec.learnerColor).toBe('b');
  });

  it('ends a Black line on Black’s move: one ply longer than a White one', () => {
    expect(familySpec(englund, [englund, others])!.depthPlies).toBe(LINE_DEPTH_PLIES + 1);
    const white = record('w', 'Sicilian-Defense', 79, 32.5, [opened('e4 c5 Nf3', 79)]);
    expect(familySpec(white, [white])!.depthPlies).toBe(LINE_DEPTH_PLIES);
  });

  it('names the family by its slug and side, and carries its commonest ECO code', () => {
    const spec = familySpec(englund, [englund, others])!;
    expect(spec.family).toBe('englund-gambit-black');
    expect(spec.name).toBe('Englund Gambit');
    expect(spec.eco).toBe('A40');
    expect(spec.branching).toBe(FAMILY_BRANCHING);
  });

  it('is null for a family whose root cannot be found', () => {
    const bare = record('b', 'Englund-Gambit', 55, 16);
    expect(familySpec(bare, [bare])).toBeNull();
  });

  it('produces a spec generateLines accepts', async () => {
    const spec = familySpec(englund, [englund, others])!;
    const lines = await generateLines(spec, {
      book: buildBook([]),
      rankMoves: async (fen, count) =>
        new Chess(fen)
          .moves({ verbose: true })
          .slice(0, count)
          .map((m) => ({ uci: `${m.from}${m.to}${m.promotion ?? ''}`, scoreCp: 0, mateIn: null })),
    });
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.every((line) => line.plies.at(-1)!.color === 'b')).toBe(true);
    expect(lines.every((line) => line.family === 'englund-gambit-black')).toBe(true);
  });
});

describe('chooseOpenings — the families to drill', () => {
  /** Every HISTORY family, given a root so each can become a spec. */
  const withRoots = HISTORY.map((r, i) => ({
    ...r,
    openings: [opened(i % 2 === 0 ? 'e4 e5' : 'd4 d5', r.games)],
  }));

  it(`takes the top ${DEFAULT_FAMILY_COUNT} by points lost`, () => {
    const chosen = chooseOpenings(withRoots);
    expect(chosen.map((c) => c.standing.family)).toEqual([
      'Englund-Gambit',
      'Scandinavian-Defense',
      'Queens-Gambit',
    ]);
    expect(DEFAULT_FAMILY_COUNT).toBe(3);
  });

  it('takes the count as a parameter', () => {
    expect(chooseOpenings(withRoots, { count: 6 })).toHaveLength(6);
  });

  it('never chooses a family the player does not lose points in, however many are asked for', () => {
    const chosen = chooseOpenings(withRoots, { count: 100 });
    expect(chosen.every((c) => c.standing.pointsLost > 0)).toBe(true);
    const names = chosen.map((c) => c.standing.family);
    expect(names).not.toContain('French-Defense');
    expect(names).not.toContain('Nimzowitsch-Defense');
    expect(names).not.toContain('Ponziani-Opening'); // below the floor
  });

  it('excludes a family that breaks exactly even', () => {
    expect(chooseOpenings([record('b', 'Even-Defense', 40, 20, [opened('e4 e5', 40)])])).toEqual(
      [],
    );
  });

  it('skips a family with no root rather than failing the run, and fills from the next', () => {
    const rows = [
      record('b', 'Bare-Defense', 100, 0),
      record('b', 'Next-Defense', 50, 10, [opened('e4 c6', 50)]),
    ];
    expect(chooseOpenings(rows, { count: 1 }).map((c) => c.standing.family)).toEqual([
      'Next-Defense',
    ]);
  });
});

describe('foldFamilyRecords — the aggregation’s rows into families', () => {
  const url = (slug: string) => `https://www.chess.com/openings/${slug}`;

  it('merges every name of a family on one side, and keeps the sides apart', () => {
    const records = foldFamilyRecords([
      {
        color: 'b',
        ecoUrl: url('Scandinavian-Defense'),
        eco: 'B01',
        sans: ['e4', 'd5'],
        games: 3,
        points: 1,
      },
      {
        color: 'b',
        ecoUrl: url('Scandinavian-Defense-2.e5'),
        eco: 'B01',
        sans: ['e4', 'd5', 'e5'],
        games: 2,
        points: 1.5,
      },
      {
        color: 'w',
        ecoUrl: url('Scandinavian-Defense'),
        eco: 'B01',
        sans: ['e4', 'd5'],
        games: 4,
        points: 4,
      },
    ]);
    expect(records).toHaveLength(2);
    const black = records.find((r) => r.color === 'b')!;
    expect(black).toMatchObject({
      family: 'Scandinavian-Defense',
      games: 5,
      points: 2.5,
      eco: 'B01',
    });
    expect(black.openings).toEqual([
      { sans: ['e4', 'd5'], games: 3 },
      { sans: ['e4', 'd5', 'e5'], games: 2 },
    ]);
  });

  it('carries the commonest ECO code among the family’s games', () => {
    const [scandinavian] = foldFamilyRecords([
      {
        color: 'b',
        ecoUrl: url('Scandinavian-Defense'),
        eco: 'B00',
        sans: ['e4', 'd5'],
        games: 1,
        points: 0,
      },
      {
        color: 'b',
        ecoUrl: url('Scandinavian-Defense-2.e5'),
        eco: 'B01',
        sans: ['e4', 'd5'],
        games: 4,
        points: 0,
      },
    ]);
    expect(scandinavian!.eco).toBe('B01');
  });

  it('leaves out games with no opening name', () => {
    expect(
      foldFamilyRecords([
        { color: 'b', ecoUrl: null, eco: null, sans: ['e4'], games: 9, points: 0 },
      ]),
    ).toEqual([]);
  });
});

describe('labels', () => {
  it('reads a slug as words, with the possessives Chess.com drops', () => {
    expect(familyLabel('Queens-Gambit')).toBe("Queen's Gambit");
    expect(familyLabel('Kings-Pawn-Opening-Kings-Knight-Variation')).toBe(
      "King's Pawn Opening King's Knight Variation",
    );
    expect(familyLabel('Englund-Gambit')).toBe('Englund Gambit');
  });

  it('keys a line family by slug and side', () => {
    expect(lineFamilyId('b', 'Queens-Gambit')).toBe('queens-gambit-black');
    expect(lineFamilyId('w', 'Sicilian-Defense')).toBe('sicilian-defense-white');
  });

  it('labels a stored family for the drill: the opening, and the side', () => {
    expect(lineFamilyLabel('queens-gambit-black', 'b')).toBe("Queen's Gambit, as Black");
    expect(lineFamilyLabel('ponziani', 'w')).toBe('Ponziani, as White');
  });
});
