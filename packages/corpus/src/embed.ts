/**
 * Turning text into vectors, behind an interface.
 *
 * Anthropic does not offer an embeddings API, so this is the one place in the project that
 * needs a second provider. Which one is a decision with cost and lock-in attached, so it is
 * not made here: an `Embedder` is injected, and the only thing this package knows is the shape.
 *
 * The dimension is fixed by the schema — `corpus_chunks.embedding` is `vector(1536)`, and the
 * HNSW index is built for that width. A provider returning a different width is a
 * configuration error, not something to pad or truncate around, so it is rejected loudly.
 */

/** Fixed by `corpus_chunks.embedding` in packages/db/src/schema.ts. */
export const EMBEDDING_DIMENSIONS = 1536;

export interface Embedder {
  /** A stable name, recorded so a re-embed can tell which vectors are stale. */
  readonly name: string;
  /** Embed a batch. The result must be in the same order as the input. */
  embed(texts: readonly string[]): Promise<number[][]>;
}

export class EmbeddingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EmbeddingError';
  }
}

/**
 * Check a provider's output before it reaches the database, where a wrong width would fail as
 * an opaque Postgres error a long way from the cause.
 */
export function assertEmbeddings(vectors: number[][], expected: number): void {
  for (const [index, vector] of vectors.entries()) {
    if (vector.length !== expected) {
      throw new EmbeddingError(
        `embedding ${index} has ${vector.length} dimensions, expected ${expected}`,
      );
    }
    if (vector.some((value) => !Number.isFinite(value))) {
      throw new EmbeddingError(`embedding ${index} contains a non-finite value`);
    }
  }
}

/**
 * Embed in batches, because providers cap how much they accept per call and a book is far more
 * than one call. Order is preserved across batches: callers pair vectors with chunks by index.
 */
export async function embedAll(
  embedder: Embedder,
  texts: readonly string[],
  batchSize = 64,
): Promise<number[][]> {
  const out: number[][] = [];

  for (let i = 0; i < texts.length; i += batchSize) {
    const batch = texts.slice(i, i + batchSize);
    const vectors = await embedder.embed(batch);

    if (vectors.length !== batch.length) {
      throw new EmbeddingError(
        `embedder returned ${vectors.length} vectors for ${batch.length} texts`,
      );
    }
    assertEmbeddings(vectors, EMBEDDING_DIMENSIONS);
    out.push(...vectors);
  }

  return out;
}
