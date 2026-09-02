import { Chess } from 'chess.js';
import { describe, expect, it } from 'vitest';

import type { Color } from './classify';
import {
  type ReviewAnalysisInput,
  type ReviewGameInput,
  type ReviewMove,
  type ReviewMoveInput,
  buildGameReview,
  chaptersOf,
  describeMove,
  formatEvaluation,
  moveAt,
  moveLabel,
  pvToSan,
  selectKeyMoments,
  uciToSan,
  winPercentOf,
} from './review';

/** 1.e4 e5 2.Bc4 Nc6 3.Qh5 Nf6?? 4.Qxf7# — short, and it ends on a real blunder. */
const SCHOLARS_MATE = ['e4', 'e5', 'Bc4', 'Nc6', 'Qh5', 'Nf6', 'Qxf7#'];

function playedMoves(sanMoves: readonly string[]): ReviewMoveInput[] {
  const board = new Chess();
  return sanMoves.map((san, index) => {
    const fenBefore = board.fen();
    const played = board.move(san);
    return {
      ply: index + 1,
      color: played.color as Color,
      san: played.san,
      uci: `${played.from}${played.to}${played.promotion ?? ''}`,
      fenBefore,
      clockMs: 60_000 - index * 1_000,
    };
  });
}

/** Analysis for the game above, as the worker would have written it. */
const SCHOLARS_ANALYSIS: ReviewAnalysisInput[] = [
  {
    ply: 1,
    evalCp: 20,
    mateIn: null,
    bestMoveUci: 'e2e4',
    pv: ['e2e4', 'c7c5'],
    centipawnLoss: 0,
    winPercentLoss: 0,
    classification: 'good',
    phase: 'opening',
    isCritical: false,
  },
  {
    ply: 2,
    evalCp: 15,
    mateIn: null,
    bestMoveUci: 'e7e5',
    pv: ['e7e5'],
    centipawnLoss: 0,
    winPercentLoss: 0,
    classification: 'good',
    phase: 'opening',
    isCritical: false,
  },
  {
    ply: 3,
    evalCp: 10,
    mateIn: null,
    bestMoveUci: 'g1f3',
    pv: ['g1f3', 'b8c6'],
    centipawnLoss: 5,
    winPercentLoss: 1,
    classification: 'good',
    phase: 'opening',
    isCritical: false,
  },
  {
    ply: 4,
    evalCp: 20,
    mateIn: null,
    bestMoveUci: 'b8c6',
    pv: ['b8c6'],
    centipawnLoss: 0,
    winPercentLoss: 0,
    classification: 'good',
    phase: 'opening',
    isCritical: false,
  },
  {
    ply: 5,
    evalCp: -30,
    mateIn: null,
    bestMoveUci: 'g1f3',
    pv: ['g1f3'],
    centipawnLoss: 50,
    winPercentLoss: 7,
    classification: 'inaccuracy',
    phase: 'opening',
    isCritical: false,
  },
  {
    ply: 6,
    evalCp: null,
    mateIn: 1,
    bestMoveUci: 'g8e7',
    pv: ['g8e7', 'h5f7'],
    centipawnLoss: 900,
    winPercentLoss: 45,
    classification: 'blunder',
    phase: 'opening',
    isCritical: true,
  },
  {
    ply: 7,
    evalCp: null,
    mateIn: 0,
    bestMoveUci: 'h5f7',
    pv: ['h5f7'],
    centipawnLoss: 0,
    winPercentLoss: 0,
    classification: 'good',
    phase: 'opening',
    isCritical: false,
  },
];

const GAME: ReviewGameInput = {
  id: 'game-1',
  userColor: 'b',
  userResult: 'loss',
  opponentUsername: 'sharpshooter',
  opponentRating: 1420,
  playedAt: new Date('2026-02-03T18:00:00Z'),
  timeControl: '600',
  eco: 'C50',
};

function buildScholars(analysis: readonly ReviewAnalysisInput[] = SCHOLARS_ANALYSIS) {
  return buildGameReview({ game: GAME, moves: playedMoves(SCHOLARS_MATE), analysis });
}

/** The same game as the worker first sees it: moves ingested, nothing analysed. */
function buildUnanalysed() {
  return buildGameReview({ game: GAME, moves: playedMoves(SCHOLARS_MATE) });
}

/** A ReviewMove with everything defaulted, so a test can vary just what it is about. */
function reviewMove(overrides: Partial<ReviewMove> & Pick<ReviewMove, 'ply'>): ReviewMove {
  return {
    moveNumber: Math.floor((overrides.ply - 1) / 2) + 1,
    color: overrides.ply % 2 === 1 ? 'w' : 'b',
    label: '1.',
    san: 'e4',
    uci: 'e2e4',
    fenBefore: 'startpos',
    fenAfter: 'startpos',
    evalBefore: null,
    evalAfter: null,
    centipawnLoss: 0,
    winPercentLoss: 0,
    classification: 'good',
    phase: 'middlegame',
    isCritical: false,
    byPlayer: false,
    bestMoveUci: null,
    bestMoveSan: null,
    bestLineSan: [],
    clockMs: null,
    annotation: '',
    ...overrides,
  };
}

describe('formatEvaluation', () => {
  it('renders centipawns as signed pawns', () => {
    expect(formatEvaluation({ cp: 190, mateIn: null })).toBe('+1.9');
    expect(formatEvaluation({ cp: -40, mateIn: null })).toBe('-0.4');
    expect(formatEvaluation({ cp: 0, mateIn: null })).toBe('+0.0');
  });

  it('renders a forced mate, and says nothing when there is no evaluation', () => {
    expect(formatEvaluation({ cp: null, mateIn: 5 })).toBe('M5');
    expect(formatEvaluation({ cp: null, mateIn: -3 })).toBe('-M3');
    expect(formatEvaluation(null)).toBe('?');
    expect(formatEvaluation({ cp: null, mateIn: null })).toBe('?');
  });
});

describe('winPercentOf', () => {
  it('is 50 for a dead level position and higher when White is better', () => {
    expect(winPercentOf({ cp: 0, mateIn: null })).toBeCloseTo(50, 5);
    expect(winPercentOf({ cp: 300, mateIn: null })!).toBeGreaterThan(70);
    expect(winPercentOf(null)).toBeNull();
  });
});

describe('uciToSan', () => {
  const afterQh5 = 'r1bqkbnr/pppp1ppp/2n5/4p2Q/2B1P3/8/PPPP1PPP/RNB1K1NR b KQkq - 3 3';

  it('renders a legal move in the notation the player reads', () => {
    expect(uciToSan(afterQh5, 'g8f6')).toBe('Nf6');
  });

  it('refuses to invent a move that is not legal in the position', () => {
    expect(uciToSan(afterQh5, 'a1a8')).toBeNull();
    expect(uciToSan(afterQh5, null)).toBeNull();
    expect(uciToSan(afterQh5, 'zz')).toBeNull();
  });
});

describe('pvToSan', () => {
  const afterQh5 = 'r1bqkbnr/pppp1ppp/2n5/4p2Q/2B1P3/8/PPPP1PPP/RNB1K1NR b KQkq - 3 3';

  it('walks the line forwards', () => {
    expect(pvToSan(afterQh5, ['g8e7', 'h5f7'])).toEqual(['Nge7', 'Qxf7#']);
  });

  it('stops at the first move that will not play rather than throwing', () => {
    expect(pvToSan(afterQh5, ['g8e7', 'a1a8', 'h5f7'])).toEqual(['Nge7']);
  });

  it('truncates to the requested length, and tolerates no line at all', () => {
    expect(pvToSan(afterQh5, ['g8e7', 'h5f7'], 1)).toEqual(['Nge7']);
    expect(pvToSan(afterQh5, null)).toEqual([]);
    expect(pvToSan(afterQh5, [])).toEqual([]);
  });
});

describe('buildGameReview', () => {
  it('produces one annotated move per ply, numbered as a player would read it', () => {
    const review = buildScholars();

    expect(review.moves).toHaveLength(7);
    expect(review.moves.map((move) => move.label)).toEqual([
      '1.',
      '1...',
      '2.',
      '2...',
      '3.',
      '3...',
      '4.',
    ]);
    expect(review.moves.map((move) => move.san)).toEqual(SCHOLARS_MATE);
  });

  it('marks the coached side, and only that side, as the player', () => {
    const review = buildScholars();
    expect(review.perspective).toBe('b');
    expect(review.moves.filter((move) => move.byPlayer).map((move) => move.san)).toEqual([
      'e5',
      'Nc6',
      'Nf6',
    ]);
  });

  it('chains the positions so the board can walk forwards', () => {
    const review = buildScholars();
    for (const [index, move] of review.moves.entries()) {
      const next = review.moves[index + 1];
      if (next) expect(move.fenAfter).toBe(next.fenBefore);
    }
    expect(review.startFen).toBe(review.moves[0]!.fenBefore);
  });

  it('reads the evaluation before a move off the previous ply, and has none for the first', () => {
    const review = buildScholars();
    expect(review.moves[0]!.evalBefore).toBeNull();
    expect(review.moves[0]!.evalAfter).toEqual({ cp: 20, mateIn: null });
    expect(review.moves[1]!.evalBefore).toEqual({ cp: 20, mateIn: null });
    expect(review.moves[5]!.evalBefore).toEqual({ cp: -30, mateIn: null });
    expect(review.moves[5]!.evalAfter).toEqual({ cp: null, mateIn: 1 });
  });

  it('renders the engine move and line in SAN from the position it was found in', () => {
    const blunder = moveAt(buildScholars(), 6)!;
    expect(blunder.bestMoveUci).toBe('g8e7');
    expect(blunder.bestMoveSan).toBe('Nge7');
    expect(blunder.bestLineSan).toEqual(['Nge7', 'Qxf7#']);
  });

  it('annotates a blunder with the engine facts and nothing else', () => {
    const blunder = moveAt(buildScholars(), 6)!;
    expect(blunder.annotation).toBe(
      'Blunder: -45% win chance. Eval -0.3 → M1. Engine: 3...Nge7. Critical moment.',
    );
  });

  it('says so plainly when the played move was the engine move', () => {
    expect(moveAt(buildScholars(), 1)!.annotation).toBe('Best move. Eval +0.2.');
    expect(moveAt(buildScholars(), 3)!.annotation).toBe(
      'Good move. Eval +0.1 → +0.1. Engine: 2.Nf3.',
    );
  });

  it('carries the clock through for time-trouble coaching', () => {
    expect(moveAt(buildScholars(), 1)!.clockMs).toBe(60_000);
    expect(moveAt(buildScholars(), 7)!.clockMs).toBe(54_000);
  });

  it('computes accuracy per side from the engine losses', () => {
    const review = buildScholars();
    expect(review.accuracy.player).not.toBeNull();
    expect(review.accuracy.opponent).not.toBeNull();
    // Black walked into mate; White gave up 7% once. White played the better game.
    expect(review.accuracy.opponent!).toBeGreaterThan(review.accuracy.player!);
  });

  it('still walks a game the worker has not analysed yet', () => {
    const review = buildUnanalysed();

    expect(review.analysed).toBe(false);
    expect(review.moves).toHaveLength(7);
    expect(review.moves.every((move) => move.annotation === 'Not analysed yet.')).toBe(true);
    expect(review.moves.every((move) => move.evalAfter === null)).toBe(true);
    expect(review.keyMoments).toEqual([]);
    expect(review.accuracy).toEqual({ player: null, opponent: null });
    // The phase is still known: it is a property of the position, not of the analysis.
    expect(review.moves.every((move) => move.phase === 'opening')).toBe(true);
  });

  it('tolerates analysis that stops part way through a game', () => {
    const review = buildScholars(SCHOLARS_ANALYSIS.slice(0, 3));

    expect(review.analysed).toBe(true);
    expect(moveAt(review, 3)!.evalAfter).toEqual({ cp: 10, mateIn: null });
    expect(moveAt(review, 4)!.evalAfter).toBeNull();
    expect(moveAt(review, 4)!.classification).toBe('good');
  });

  it('picks the blunder as the moment worth explaining', () => {
    const review = buildScholars();
    expect(review.keyMoments.map((moment) => ({ ply: moment.ply, reason: moment.reason }))).toEqual([
      { ply: 5, reason: 'inaccuracy' },
      { ply: 6, reason: 'turning-point' },
    ]);
  });
});

describe('selectKeyMoments', () => {
  it('ignores moves the engine had no complaint about', () => {
    const moves = [
      reviewMove({ ply: 1, classification: 'good' }),
      reviewMove({ ply: 2, classification: 'good', winPercentLoss: 3 }),
    ];
    expect(selectKeyMoments(moves)).toEqual([]);
  });

  it('keeps a critical swing even when the move itself was sound', () => {
    const moves = [reviewMove({ ply: 9, classification: 'good', isCritical: true })];
    expect(selectKeyMoments(moves).map((moment) => moment.reason)).toEqual(['turning-point']);
  });

  it('ranks the coached player above their opponent at the same cost', () => {
    const moves = [
      reviewMove({ ply: 4, classification: 'mistake', winPercentLoss: 12, byPlayer: false }),
      reviewMove({ ply: 5, classification: 'mistake', winPercentLoss: 12, byPlayer: true }),
    ];
    expect(selectKeyMoments(moves, { limit: 1 })).toEqual([
      { ply: 5, reason: 'turning-point', weight: 18 },
    ]);
  });

  it('spends a small budget on the largest swings but reads in ply order', () => {
    const moves = [
      reviewMove({ ply: 2, classification: 'inaccuracy', winPercentLoss: 6 }),
      reviewMove({ ply: 4, classification: 'blunder', winPercentLoss: 40 }),
      reviewMove({ ply: 6, classification: 'mistake', winPercentLoss: 14 }),
      reviewMove({ ply: 8, classification: 'inaccuracy', winPercentLoss: 5 }),
    ];

    const chosen = selectKeyMoments(moves, { limit: 2 });
    expect(chosen.map((moment) => moment.ply)).toEqual([4, 6]);
    expect(chosen[0]!.reason).toBe('turning-point');
    expect(chosen[1]!.reason).toBe('mistake');
  });

  it('returns nothing when there is no budget', () => {
    const moves = [reviewMove({ ply: 4, classification: 'blunder', winPercentLoss: 40 })];
    expect(selectKeyMoments(moves, { limit: 0 })).toEqual([]);
  });
});

describe('chaptersOf', () => {
  it('groups consecutive plies of the same phase and scores the coached side in each', () => {
    const moves = [
      reviewMove({ ply: 1, phase: 'opening' }),
      reviewMove({ ply: 2, phase: 'opening', byPlayer: true, winPercentLoss: 2 }),
      reviewMove({ ply: 3, phase: 'middlegame' }),
      reviewMove({
        ply: 4,
        phase: 'middlegame',
        byPlayer: true,
        winPercentLoss: 30,
        classification: 'blunder',
      }),
      reviewMove({ ply: 5, phase: 'endgame' }),
    ];

    const chapters = chaptersOf(moves);
    expect(chapters.map((chapter) => [chapter.phase, chapter.fromPly, chapter.toPly])).toEqual([
      ['opening', 1, 2],
      ['middlegame', 3, 4],
      ['endgame', 5, 5],
    ]);
    expect(chapters[0]!.playerBlunders).toBe(0);
    expect(chapters[1]!.playerBlunders).toBe(1);
    expect(chapters[0]!.playerAccuracy!).toBeGreaterThan(chapters[1]!.playerAccuracy!);
    // The coached side never moved in the endgame chapter, so there is nothing to score.
    expect(chapters[2]!.playerAccuracy).toBeNull();
  });

  it('starts a new chapter when a promotion pushes an endgame back into a middlegame', () => {
    const moves = [
      reviewMove({ ply: 1, phase: 'endgame' }),
      reviewMove({ ply: 2, phase: 'middlegame' }),
      reviewMove({ ply: 3, phase: 'endgame' }),
    ];
    expect(chaptersOf(moves).map((chapter) => chapter.phase)).toEqual([
      'endgame',
      'middlegame',
      'endgame',
    ]);
  });
});

describe('describeMove', () => {
  it('never claims an evaluation it was not given', () => {
    const annotation = describeMove(
      {
        classification: 'good',
        winPercentLoss: 0,
        evalBefore: null,
        evalAfter: null,
        san: 'Nf3',
        bestMoveSan: null,
        isCritical: false,
        moveNumber: 2,
        color: 'w',
      },
      true,
    );
    expect(annotation).toBe('Good move.');
    expect(annotation).not.toContain('Eval');
  });

  it('reports nothing at all about an unanalysed move', () => {
    expect(
      describeMove(
        {
          classification: 'good',
          winPercentLoss: 0,
          evalBefore: { cp: 20, mateIn: null },
          evalAfter: { cp: 30, mateIn: null },
          san: 'Nf3',
          bestMoveSan: 'Nf3',
          isCritical: false,
          moveNumber: 2,
          color: 'w',
        },
        false,
      ),
    ).toBe('Not analysed yet.');
  });
});

describe('moveLabel', () => {
  it('distinguishes the two halves of a move', () => {
    expect(moveLabel(21, 'w')).toBe('21.');
    expect(moveLabel(21, 'b')).toBe('21...');
  });
});
