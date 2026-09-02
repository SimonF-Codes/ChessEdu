import { createRetriever, embedderFromEnv } from '@chessedu/corpus';
import { db } from '@chessedu/db';

import { type RetrieveChunks, noCorpus } from './retrieval';

/**
 * Binds the coach to the real corpus, or to nothing.
 *
 * This is the file `retrieval.ts` was written to make small: the coach knows one injected
 * function, and swapping the stub for pgvector happens here and nowhere else.
 *
 * With no embedding provider configured this returns `noCorpus`, and the coach answers
 * normally with zero citations. That is a supported state rather than a degraded one — a game
 * review is worth reading without reference literature attached, and blocking it on a vendor
 * being set up would be the worse trade.
 */
export function corpusRetriever(): RetrieveChunks {
  const embedder = embedderFromEnv();
  if (!embedder) return noCorpus;

  // The shapes are identical by construction — packages/corpus was written against the
  // interface in retrieval.ts. The cast is here only because the two declare it separately,
  // which is what keeps the coach from depending on the corpus package.
  return createRetriever(db(), embedder) as RetrieveChunks;
}
