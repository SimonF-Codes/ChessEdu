import type { GameReview } from '@chessedu/chess';

import { type MomentFacts, factsForReview } from './facts';
import { type RetrievedPassage, retrievePassages } from './passages';
import { COACH_SYSTEM, buildCoachPrompt } from './prompt';
import { type Citation, type RetrieveChunks, noCorpus } from './retrieval';

/**
 * Turning key moments into prose, and refusing to let anything the model made up through.
 *
 * The model is injected so this whole path is testable without a network call and without an
 * API key — see annotate.test.ts. The Anthropic binding lives in anthropic-model.ts.
 */

export interface CommentaryModel {
  complete(input: { system: string; prompt: string; signal?: AbortSignal }): Promise<string>;
}

export interface MoveComment {
  ply: number;
  comment: string;
  citations: Citation[];
}

export interface CoachCommentary {
  comments: MoveComment[];
  moments: MomentFacts[];
  passages: RetrievedPassage[];
}

/** Raised when the model's reply is not the JSON it was asked for. */
export class CommentaryFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CommentaryFormatError';
  }
}

/** A comment is an explanation, not an essay. */
export const MAX_COMMENT_CHARS = 1200;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The JSON object inside a reply, tolerating a code fence or a stray sentence around it. */
function extractJson(raw: string): string {
  const withoutFence = raw
    .replace(/^\s*```(?:json)?/i, '')
    .replace(/```\s*$/, '')
    .trim();
  const start = withoutFence.indexOf('{');
  const end = withoutFence.lastIndexOf('}');
  if (start === -1 || end <= start) {
    throw new CommentaryFormatError('the reply contained no JSON object');
  }
  return withoutFence.slice(start, end + 1);
}

/**
 * Parse the model's reply into comments, dropping everything it was not entitled to say.
 *
 * Two things are enforced here rather than trusted to the prompt: a comment on a ply that was
 * never sent is discarded, and a citation id that was never supplied is discarded. A
 * fabricated source cannot reach the page.
 */
export function parseCommentary(
  raw: string,
  context: { allowedPlies: Iterable<number>; passages: readonly RetrievedPassage[] },
): MoveComment[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(extractJson(raw));
  } catch (error) {
    if (error instanceof CommentaryFormatError) throw error;
    throw new CommentaryFormatError('the reply was not valid JSON');
  }

  if (!isRecord(parsed) || !Array.isArray(parsed.comments)) {
    throw new CommentaryFormatError('the reply had no "comments" array');
  }

  const allowed = new Set(context.allowedPlies);
  const byId = new Map(context.passages.map((passage) => [passage.id, passage.citation]));
  const seen = new Set<number>();
  const comments: MoveComment[] = [];

  for (const entry of parsed.comments) {
    if (!isRecord(entry)) continue;

    const ply = entry.ply;
    if (typeof ply !== 'number' || !allowed.has(ply) || seen.has(ply)) continue;

    const text = typeof entry.comment === 'string' ? entry.comment.trim() : '';
    if (text.length === 0) continue;

    const citations: Citation[] = [];
    if (Array.isArray(entry.citations)) {
      for (const id of entry.citations) {
        if (typeof id !== 'string') continue;
        const citation = byId.get(id);
        if (citation && !citations.some((existing) => existing.chunkId === id)) {
          citations.push(citation);
        }
      }
    }

    seen.add(ply);
    comments.push({
      ply,
      comment: text.length > MAX_COMMENT_CHARS ? `${text.slice(0, MAX_COMMENT_CHARS).trimEnd()}…` : text,
      citations,
    });
  }

  return comments.sort((a, b) => a.ply - b.ply);
}

/**
 * Explain the key moments of a review.
 *
 * Costs one model call, and none at all when the engine found nothing worth explaining — a
 * clean game gets its deterministic annotations and no bill.
 */
export async function annotateReview(input: {
  review: GameReview;
  model: CommentaryModel;
  retrieve?: RetrieveChunks;
  /** Cap the moments explained. The review already caps them; this narrows further. */
  limit?: number;
  signal?: AbortSignal;
}): Promise<CoachCommentary> {
  const all = factsForReview(input.review);
  const moments = input.limit === undefined ? all : all.slice(0, Math.max(0, input.limit));

  if (moments.length === 0) {
    return { comments: [], moments: [], passages: [] };
  }

  const passages = await retrievePassages({
    review: input.review,
    moments,
    retrieve: input.retrieve ?? noCorpus,
    signal: input.signal,
  });

  const raw = await input.model.complete({
    system: COACH_SYSTEM,
    prompt: buildCoachPrompt({ review: input.review, moments, passages }),
    signal: input.signal,
  });

  const comments = parseCommentary(raw, {
    allowedPlies: moments.map((moment) => moment.ply),
    passages,
  });

  return { comments, moments, passages };
}
