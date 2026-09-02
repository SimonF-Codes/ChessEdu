import { sql } from 'drizzle-orm';

import type { Database } from '@chessedu/db';

import { EMBEDDING_DIMENSIONS, type Embedder, assertEmbeddings } from './embed';

/**
 * Finding the passages a claim can be attributed to.
 *
 * The shape here is the one `apps/web/lib/coach/retrieval.ts` was written against — see the
 * corpus retrieval interface in docs/architecture.md. Keeping it identical is the point: the
 * coach was built to swap its stub for this without changing anything downstream.
 */

export interface ChunkSource {
  docId: string;
  title: string;
  author: string | null;
  year: number | null;
}

export interface CorpusChunk {
  id: string;
  content: string;
  source: ChunkSource;
  locator: string | null;
  /** Cosine similarity in 0..1, where 1 is identical. */
  score?: number;
}

export interface RetrieveOptions {
  limit?: number;
  signal?: AbortSignal;
}

export type RetrieveChunks = (
  query: string,
  options?: RetrieveOptions,
) => Promise<CorpusChunk[]>;

export const DEFAULT_LIMIT = 6;

/**
 * Below this a passage is closer to noise than to evidence, and citing it would be worse than
 * citing nothing — the whole point of the corpus is that a citation can be checked.
 */
export const MIN_SCORE = 0.35;

/** Postgres vector literal: `[0.1,0.2,...]`. */
function toVectorLiteral(vector: readonly number[]): string {
  return `[${vector.join(',')}]`;
}

/**
 * Build the retriever the coach consumes.
 *
 * Returns passages ordered by similarity, best first, filtered by `MIN_SCORE`. An empty result
 * is normal and not an error: the coach is designed to run uncited when the corpus has nothing
 * to say, and answering with a weak citation would be the worse failure.
 */
export function createRetriever(db: Database, embedder: Embedder): RetrieveChunks {
  return async (query, options = {}) => {
    const text = query.trim();
    if (!text) return [];

    const [embedding] = await embedder.embed([text]);
    if (!embedding) return [];
    assertEmbeddings([embedding], EMBEDDING_DIMENSIONS);

    const limit = options.limit ?? DEFAULT_LIMIT;
    const literal = toVectorLiteral(embedding);

    // `<=>` is pgvector's cosine distance, so similarity is 1 - distance. Ordering by the
    // operator directly is what lets the HNSW index be used; ordering by the derived column
    // would not.
    const rows = await db.execute<{
      id: string;
      content: string;
      locator: string | null;
      doc_id: string;
      title: string;
      author: string | null;
      year: number | null;
      score: number;
    }>(sql`
      select
        c.id,
        c.content,
        c.locator,
        d.id as doc_id,
        d.title,
        d.author,
        d.year,
        1 - (c.embedding <=> ${literal}::vector) as score
      from corpus_chunk c
      join corpus_doc d on d.id = c.doc_id
      where c.embedding is not null
      order by c.embedding <=> ${literal}::vector
      limit ${limit}
    `);

    return (rows as unknown as Record<string, unknown>[])
      .map((row) => ({
        id: String(row.id),
        content: String(row.content),
        locator: row.locator === null ? null : String(row.locator),
        source: {
          docId: String(row.doc_id),
          title: String(row.title),
          author: row.author === null ? null : String(row.author),
          year: row.year === null ? null : Number(row.year),
        },
        score: Number(row.score),
      }))
      .filter((chunk) => (chunk.score ?? 0) >= MIN_SCORE);
  };
}
