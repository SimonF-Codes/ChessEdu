import type { GameReview } from '@chessedu/chess';

import { type MomentFacts, retrievalQuery } from './facts';
import { type Citation, type RetrieveChunks, formatCitation, toCitation } from './retrieval';

/** A corpus chunk as the prompt and the page see it. */
export interface RetrievedPassage {
  id: string;
  content: string;
  citation: Citation;
  /** `Nimzowitsch, My System (1925), ch. 4, p. 91` */
  citationLine: string;
  /** The moments this passage was retrieved for. One passage can serve several. */
  plies: number[];
}

/** Two passages per moment: enough to have a choice, few enough to stay readable. */
export const CHUNKS_PER_MOMENT = 2;

/** Chunks are prose, not books. A long one is truncated rather than dropped. */
export const MAX_PASSAGE_CHARS = 900;

function truncate(content: string, max = MAX_PASSAGE_CHARS): string {
  const trimmed = content.trim();
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max).trimEnd()}…`;
}

/**
 * Retrieve reference passages for the moments about to be explained.
 *
 * Deduplicated across moments, because the same chapter often speaks to two mistakes of the
 * same kind, and the model should see it once with both plies attached.
 *
 * A corpus that is missing, empty, or failing is not an error: the review is worth reading
 * uncited, so retrieval failures degrade to no passages rather than failing the request.
 */
export async function retrievePassages(input: {
  review: GameReview;
  moments: readonly MomentFacts[];
  retrieve: RetrieveChunks;
  signal?: AbortSignal;
}): Promise<RetrievedPassage[]> {
  const results = await Promise.all(
    input.moments.map(async (moment) => {
      const query = retrievalQuery(input.review, moment);
      try {
        const chunks = await input.retrieve(query, {
          limit: CHUNKS_PER_MOMENT,
          signal: input.signal,
        });
        return { ply: moment.ply, chunks };
      } catch (error) {
        console.warn(`[coach] corpus retrieval failed for ply ${moment.ply}:`, error);
        return { ply: moment.ply, chunks: [] };
      }
    }),
  );

  const byId = new Map<string, RetrievedPassage>();
  for (const { ply, chunks } of results) {
    for (const chunk of chunks.slice(0, CHUNKS_PER_MOMENT)) {
      const existing = byId.get(chunk.id);
      if (existing) {
        if (!existing.plies.includes(ply)) existing.plies.push(ply);
        continue;
      }
      const citation = toCitation(chunk);
      byId.set(chunk.id, {
        id: chunk.id,
        content: truncate(chunk.content),
        citation,
        citationLine: formatCitation(citation),
        plies: [ply],
      });
    }
  }

  return [...byId.values()];
}
