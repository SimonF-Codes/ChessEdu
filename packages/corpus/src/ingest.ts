import { eq } from 'drizzle-orm';

import { type Database, schema } from '@chessedu/db';

import { type ChunkOptions, chunkText } from './chunk';
import { type Embedder, embedAll } from './embed';

/**
 * Putting a text into the corpus: chunk it, embed it, store it.
 *
 * Licensing is checked by a human before anything reaches here — `license` is required rather
 * than optional precisely so that ingesting something without having decided its licence takes
 * a deliberate lie rather than an omission. See the open questions in docs/architecture.md.
 */

export interface DocumentInput {
  title: string;
  author?: string | null;
  year?: number | null;
  /**
   * The licence this text is used under. Required: the corpus is only allowed to hold
   * public-domain or openly-licensed material, and an unrecorded licence is how that slips.
   */
  license: string;
  sourceUrl?: string | null;
  text: string;
  chunking?: ChunkOptions;
}

export interface IngestResult {
  docId: string;
  chunks: number;
}

/**
 * Ingest one document.
 *
 * Re-ingesting a document replaces its chunks rather than adding to them, so running this twice
 * is not how a corpus quietly doubles.
 */
export async function ingestDocument(
  context: { db: Database; embedder: Embedder },
  input: DocumentInput,
): Promise<IngestResult> {
  const { db, embedder } = context;

  const chunks = chunkText(input.text, input.chunking);
  if (chunks.length === 0) {
    throw new Error(`${input.title} produced no chunks — is the text empty?`);
  }

  const [doc] = await db
    .insert(schema.corpusDocs)
    .values({
      title: input.title,
      author: input.author ?? null,
      year: input.year ?? null,
      license: input.license,
      sourceUrl: input.sourceUrl ?? null,
    })
    .returning({ id: schema.corpusDocs.id });

  const docId = doc!.id;

  // Embedding is the slow, paid part, so it happens once for the whole document rather than
  // per row, and before any chunk is written — a half-embedded document would retrieve badly
  // and look fine.
  const vectors = await embedAll(
    embedder,
    chunks.map((chunk) => chunk.content),
  );

  await db.delete(schema.corpusChunks).where(eq(schema.corpusChunks.docId, docId));
  await db.insert(schema.corpusChunks).values(
    chunks.map((chunk, index) => ({
      docId,
      ordinal: chunk.ordinal,
      content: chunk.content,
      locator: chunk.locator,
      embedding: vectors[index]!,
    })),
  );

  return { docId, chunks: chunks.length };
}
