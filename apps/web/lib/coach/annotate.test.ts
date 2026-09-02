import { Chess } from 'chess.js';
import { describe, expect, it, vi } from 'vitest';

import {
  type Color,
  type GameReview,
  type ReviewAnalysisInput,
  type ReviewMoveInput,
  buildGameReview,
} from '@chessedu/chess';

import {
  type CommentaryModel,
  CommentaryFormatError,
  MAX_COMMENT_CHARS,
  annotateReview,
  parseCommentary,
} from './annotate';
import { factsForReview, formatClock, renderFacts, retrievalQuery } from './facts';
import { type RetrievedPassage, retrievePassages } from './passages';
import { COACH_SYSTEM, buildCoachPrompt } from './prompt';
import { type CorpusChunk, type RetrieveChunks, formatCitation, noCorpus } from './retrieval';

/** 1.e4 e5 2.Bc4 Nc6 3.Qh5 Nf6?? 4.Qxf7# — Black is the student, and Black is lost. */
const SAN = ['e4', 'e5', 'Bc4', 'Nc6', 'Qh5', 'Nf6', 'Qxf7#'];

function playedMoves(): ReviewMoveInput[] {
  const board = new Chess();
  return SAN.map((san, index) => {
    const fenBefore = board.fen();
    const played = board.move(san);
    return {
      ply: index + 1,
      color: played.color as Color,
      san: played.san,
      uci: `${played.from}${played.to}${played.promotion ?? ''}`,
      fenBefore,
      clockMs: 95_000 - index * 1_000,
    };
  });
}

function analysis(): ReviewAnalysisInput[] {
  const flat = (ply: number): ReviewAnalysisInput => ({
    ply,
    evalCp: 20,
    mateIn: null,
    bestMoveUci: null,
    pv: null,
    centipawnLoss: 0,
    winPercentLoss: 0,
    classification: 'good',
    phase: 'opening',
    isCritical: false,
  });

  return [
    flat(1),
    flat(2),
    flat(3),
    flat(4),
    {
      ...flat(5),
      evalCp: -30,
      bestMoveUci: 'g1f3',
      centipawnLoss: 50,
      winPercentLoss: 7,
      classification: 'inaccuracy',
    },
    {
      ...flat(6),
      evalCp: null,
      mateIn: 1,
      bestMoveUci: 'g8e7',
      pv: ['g8e7', 'h5f7'],
      centipawnLoss: 900,
      winPercentLoss: 45,
      classification: 'blunder',
      isCritical: true,
    },
    { ...flat(7), evalCp: null, mateIn: 0, bestMoveUci: 'h5f7' },
  ];
}

function review(): GameReview {
  return buildGameReview({
    game: {
      id: 'game-1',
      userColor: 'b',
      userResult: 'loss',
      opponentUsername: 'sharpshooter',
      opponentRating: 1420,
      playedAt: new Date('2026-02-03T18:00:00Z'),
      timeControl: '600',
      eco: 'C50',
    },
    moves: playedMoves(),
    analysis: analysis(),
  });
}

/** A review of a game the engine had no complaint about. */
function cleanReview(): GameReview {
  return buildGameReview({
    game: {
      id: 'game-2',
      userColor: 'w',
      userResult: 'draw',
      opponentUsername: 'steady',
      playedAt: new Date('2026-02-04T18:00:00Z'),
      timeControl: '600',
      eco: 'C50',
    },
    moves: playedMoves().slice(0, 4),
    analysis: analysis().slice(0, 4),
  });
}

function modelReturning(raw: string): CommentaryModel & { calls: { system: string; prompt: string }[] } {
  const calls: { system: string; prompt: string }[] = [];
  return {
    calls,
    async complete({ system, prompt }) {
      calls.push({ system, prompt });
      return raw;
    },
  };
}

function chunk(overrides: Partial<CorpusChunk> & Pick<CorpusChunk, 'id'>): CorpusChunk {
  return {
    content: 'Develop with a threat only when the threat cannot be met by developing.',
    source: { docId: 'doc-1', title: 'My System', author: 'Nimzowitsch', year: 1925 },
    locator: 'ch. 4, p. 91',
    ...overrides,
  };
}

describe('formatClock', () => {
  it('reads like a chess clock', () => {
    expect(formatClock(95_000)).toBe('1:35');
    expect(formatClock(9_000)).toBe('0:09');
    expect(formatClock(3_723_000)).toBe('1:02:03');
  });

  it('has nothing to say about a game with no clocks', () => {
    expect(formatClock(null)).toBeNull();
    expect(formatClock(Number.NaN)).toBeNull();
  });
});

describe('renderFacts', () => {
  it('states every engine number the model is allowed to use', () => {
    const facts = factsForReview(review()).find((moment) => moment.ply === 6)!;
    const rendered = renderFacts(facts);

    expect(rendered).toContain('[ply 6] 3...Nf6');
    expect(rendered).toContain('the player you are coaching');
    expect(rendered).toContain('engine classification: blunder');
    expect(rendered).toContain('evaluation before the move: -0.3');
    expect(rendered).toContain('evaluation after the move: M1');
    expect(rendered).toContain('centipawns given up: 900');
    expect(rendered).toContain('win chance given up: 45%');
    expect(rendered).toContain("engine's move instead: Nge7");
    expect(rendered).toContain("engine's line: Nge7 Qxf7#");
    expect(rendered).toContain('clock remaining after the move: 1:30');
  });

  it('never sends a position without the evaluation that goes with it', () => {
    for (const facts of factsForReview(review())) {
      const rendered = renderFacts(facts);
      expect(rendered).toContain(facts.fenBefore);
      expect(rendered).toContain('evaluation before the move:');
      expect(rendered).toContain('evaluation after the move:');
    }
  });
});

describe('retrievalQuery', () => {
  it('is built from the engine facts, not from anything the model said', () => {
    const facts = factsForReview(review()).find((moment) => moment.ply === 6)!;
    const query = retrievalQuery(review(), facts);

    expect(query).toContain('C50');
    expect(query).toContain('opening');
    expect(query).toContain('blunder');
    expect(query).toContain('after 3...Nf6');
    expect(query).toContain('Nge7');
  });
});

describe('retrievePassages', () => {
  it('asks the corpus once per moment and keeps the source and locator', async () => {
    const retrieve = vi.fn<RetrieveChunks>(async () => [chunk({ id: 'c1' })]);
    const target = review();
    const moments = factsForReview(target);

    const passages = await retrievePassages({ review: target, moments, retrieve });

    expect(retrieve).toHaveBeenCalledTimes(moments.length);
    expect(passages).toHaveLength(1);
    expect(passages[0]!.citation.locator).toBe('ch. 4, p. 91');
    expect(passages[0]!.citationLine).toBe('Nimzowitsch, My System (1925), ch. 4, p. 91');
  });

  it('shows a chunk once, tagged with every moment it was retrieved for', async () => {
    const target = review();
    const moments = factsForReview(target);
    expect(moments.length).toBeGreaterThan(1);

    const passages = await retrievePassages({
      review: target,
      moments,
      retrieve: async () => [chunk({ id: 'shared' })],
    });

    expect(passages).toHaveLength(1);
    expect(passages[0]!.plies).toEqual(moments.map((moment) => moment.ply));
  });

  it('degrades to no passages when the corpus is unavailable', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const target = review();

    const passages = await retrievePassages({
      review: target,
      moments: factsForReview(target),
      retrieve: async () => {
        throw new Error('pgvector is down');
      },
    });

    expect(passages).toEqual([]);
    warn.mockRestore();
  });

  it('returns nothing at all against the default no-corpus binding', async () => {
    const target = review();
    expect(
      await retrievePassages({ review: target, moments: factsForReview(target), retrieve: noCorpus }),
    ).toEqual([]);
  });
});

describe('buildCoachPrompt', () => {
  it('gives the model the game, the moments, and the passages it may cite', () => {
    const target = review();
    const moments = factsForReview(target);
    const passages: RetrievedPassage[] = [
      {
        id: 'c1',
        content: 'A knight on the rim...',
        citation: {
          chunkId: 'c1',
          title: 'My System',
          author: 'Nimzowitsch',
          year: 1925,
          locator: 'ch. 4',
        },
        citationLine: 'Nimzowitsch, My System (1925), ch. 4',
        plies: [6],
      },
    ];

    const prompt = buildCoachPrompt({ review: target, moments, passages });

    expect(prompt).toContain('had Black and lost');
    expect(prompt).toContain('sharpshooter (1420)');
    expect(prompt).toContain('[ply 6] 3...Nf6');
    expect(prompt).toContain('[c1] Nimzowitsch, My System (1925), ch. 4');
    expect(prompt).toContain('relevant to ply 6');
  });

  it('tells the model to cite nothing when nothing was retrieved', () => {
    const target = review();
    const prompt = buildCoachPrompt({ review: target, moments: factsForReview(target), passages: [] });
    expect(prompt).toContain('Cite nothing');
  });

  it('forbids the model from producing its own numbers', () => {
    expect(COACH_SYSTEM).toContain('Never state an evaluation, best move, accuracy, or classification');
    expect(COACH_SYSTEM).toContain('Never cite an id you were not');
    expect(COACH_SYSTEM).toContain('never invent a title, author, or page number');
  });
});

describe('parseCommentary', () => {
  const passages: RetrievedPassage[] = [
    {
      id: 'c1',
      content: 'text',
      citation: { chunkId: 'c1', title: 'My System', author: 'Nimzowitsch', year: 1925, locator: 'p. 91' },
      citationLine: 'Nimzowitsch, My System (1925), p. 91',
      plies: [6],
    },
  ];
  const context = { allowedPlies: [5, 6], passages };

  it('reads the JSON it asked for', () => {
    const parsed = parseCommentary(
      '{"comments":[{"ply":6,"comment":"You developed into the attack.","citations":["c1"]}]}',
      context,
    );

    expect(parsed).toEqual([
      {
        ply: 6,
        comment: 'You developed into the attack.',
        citations: [passages[0]!.citation],
      },
    ]);
  });

  it('tolerates a code fence and stray prose around the JSON', () => {
    const parsed = parseCommentary(
      'Sure, here you go:\n```json\n{"comments":[{"ply":5,"comment":"Early queen.","citations":[]}]}\n```',
      context,
    );
    expect(parsed.map((comment) => comment.ply)).toEqual([5]);
  });

  it('drops a comment on a ply that was never sent', () => {
    const parsed = parseCommentary(
      '{"comments":[{"ply":6,"comment":"Real.","citations":[]},{"ply":2,"comment":"Invented.","citations":[]}]}',
      context,
    );
    expect(parsed.map((comment) => comment.ply)).toEqual([6]);
  });

  it('drops a citation the model was never given, keeping the comment', () => {
    const parsed = parseCommentary(
      '{"comments":[{"ply":6,"comment":"Real.","citations":["c1","fabricated-99"]}]}',
      context,
    );
    expect(parsed[0]!.citations.map((citation) => citation.chunkId)).toEqual(['c1']);
  });

  it('drops every citation when nothing was retrieved', () => {
    const parsed = parseCommentary(
      '{"comments":[{"ply":6,"comment":"Real.","citations":["c1"]}]}',
      { allowedPlies: [6], passages: [] },
    );
    expect(parsed[0]!.citations).toEqual([]);
  });

  it('keeps the first comment when a ply is answered twice', () => {
    const parsed = parseCommentary(
      '{"comments":[{"ply":6,"comment":"First."},{"ply":6,"comment":"Second."}]}',
      context,
    );
    expect(parsed).toHaveLength(1);
    expect(parsed[0]!.comment).toBe('First.');
  });

  it('skips malformed entries rather than failing the whole reply', () => {
    const parsed = parseCommentary(
      '{"comments":[null,{"ply":"six","comment":"x"},{"ply":6,"comment":"   "},{"ply":5,"comment":"Kept."}]}',
      context,
    );
    expect(parsed.map((comment) => comment.comment)).toEqual(['Kept.']);
  });

  it('returns comments in ply order whatever order they arrived in', () => {
    const parsed = parseCommentary(
      '{"comments":[{"ply":6,"comment":"Later."},{"ply":5,"comment":"Earlier."}]}',
      context,
    );
    expect(parsed.map((comment) => comment.ply)).toEqual([5, 6]);
  });

  it('caps a runaway comment', () => {
    const parsed = parseCommentary(
      JSON.stringify({ comments: [{ ply: 6, comment: 'x'.repeat(MAX_COMMENT_CHARS + 500) }] }),
      context,
    );
    expect(parsed[0]!.comment.length).toBe(MAX_COMMENT_CHARS + 1);
    expect(parsed[0]!.comment.endsWith('…')).toBe(true);
  });

  it('rejects a reply that is not the JSON it was asked for', () => {
    expect(() => parseCommentary('I am afraid I cannot do that.', context)).toThrow(
      CommentaryFormatError,
    );
    expect(() => parseCommentary('{"nope": true}', context)).toThrow(CommentaryFormatError);
    expect(() => parseCommentary('{"comments": [', context)).toThrow(CommentaryFormatError);
  });
});

describe('annotateReview', () => {
  it('explains the key moments and nothing else', async () => {
    const target = review();
    const model = modelReturning(
      '{"comments":[{"ply":5,"comment":"An early queen sortie.","citations":[]},{"ply":6,"comment":"This let mate in.","citations":[]}]}',
    );

    const result = await annotateReview({ review: target, model });

    expect(result.comments.map((comment) => comment.ply)).toEqual([5, 6]);
    expect(result.moments.map((moment) => moment.ply)).toEqual([5, 6]);
    expect(model.calls).toHaveLength(1);
    expect(model.calls[0]!.system).toBe(COACH_SYSTEM);
  });

  it('costs nothing when the engine found nothing worth explaining', async () => {
    const model = modelReturning('{"comments":[]}');
    const result = await annotateReview({ review: cleanReview(), model });

    expect(result).toEqual({ comments: [], moments: [], passages: [] });
    expect(model.calls).toHaveLength(0);
  });

  it('narrows to the requested number of moments', async () => {
    const target = review();
    const model = modelReturning('{"comments":[{"ply":5,"comment":"Only one."}]}');

    const result = await annotateReview({ review: target, model, limit: 1 });

    expect(result.moments).toHaveLength(1);
    expect(model.calls[0]!.prompt).toContain('[ply 5]');
    expect(model.calls[0]!.prompt).not.toContain('[ply 6]');
  });

  it('puts retrieved passages in the prompt and their sources on the comment', async () => {
    const target = review();
    const model = modelReturning(
      '{"comments":[{"ply":6,"comment":"Development with a threat.","citations":["c1"]}]}',
    );
    const retrieve: RetrieveChunks = async () => [chunk({ id: 'c1' })];

    const result = await annotateReview({ review: target, model, retrieve });

    expect(model.calls[0]!.prompt).toContain('[c1] Nimzowitsch, My System (1925), ch. 4, p. 91');
    expect(result.comments[0]!.citations).toHaveLength(1);
    expect(formatCitation(result.comments[0]!.citations[0]!)).toBe(
      'Nimzowitsch, My System (1925), ch. 4, p. 91',
    );
  });

  it('runs uncited by default', async () => {
    const target = review();
    const model = modelReturning('{"comments":[{"ply":6,"comment":"No source.","citations":["c1"]}]}');

    const result = await annotateReview({ review: target, model });

    expect(result.passages).toEqual([]);
    expect(result.comments[0]!.citations).toEqual([]);
  });

  it('surfaces a model that answered with something else', async () => {
    const target = review();
    await expect(
      annotateReview({ review: target, model: modelReturning('sorry, no') }),
    ).rejects.toBeInstanceOf(CommentaryFormatError);
  });
});
