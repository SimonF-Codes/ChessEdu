/**
 * The coach's dependency on the reference corpus, and nothing more.
 *
 * The corpus — ingestion, chunking, embeddings, the pgvector query — is owned elsewhere. This
 * file is the whole of the coach's knowledge of it: one injected function. Everything
 * downstream consumes the `Citation` produced here, so when the real retrieval contract lands
 * only this file changes.
 *
 * PROVISIONAL: the signature below is a placeholder for that contract. See the corpus
 * retrieval interface in docs/architecture.md before changing it.
 */

/** Where a chunk came from, so a claim can be attributed rather than recalled. */
export interface ChunkSource {
  docId: string;
  title: string;
  author: string | null;
  year: number | null;
}

/** One retrieved passage of reference literature. */
export interface CorpusChunk {
  id: string;
  content: string;
  source: ChunkSource;
  /** Citable location within the source, e.g. "ch. 4, p. 91". */
  locator: string | null;
  /** Similarity, if the retriever reports one. Ordering is the retriever's job, not ours. */
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

/**
 * The default binding: no corpus.
 *
 * The coach is expected to run uncited — a game review is worth reading without reference
 * literature attached, and the corpus is not a prerequisite for shipping this page.
 */
export const noCorpus: RetrieveChunks = async () => [];

/** What the model is shown, and what the page renders under a comment. */
export interface Citation {
  chunkId: string;
  title: string;
  author: string | null;
  year: number | null;
  locator: string | null;
}

export function toCitation(chunk: CorpusChunk): Citation {
  return {
    chunkId: chunk.id,
    title: chunk.source.title,
    author: chunk.source.author,
    year: chunk.source.year,
    locator: chunk.locator,
  };
}

/** `Nimzowitsch, My System (1925), ch. 4, p. 91` — a reader can go and check it. */
export function formatCitation(citation: Citation): string {
  const parts: string[] = [];
  if (citation.author) parts.push(citation.author);
  parts.push(citation.year ? `${citation.title} (${citation.year})` : citation.title);
  if (citation.locator) parts.push(citation.locator);
  return parts.join(', ');
}
