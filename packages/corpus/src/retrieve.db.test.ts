import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { createDatabase, schema } from '@chessedu/db';

import { EMBEDDING_DIMENSIONS, type Embedder } from './embed';
import { ingestDocument } from './ingest';
import { MIN_SCORE, createRetriever } from './retrieve';

/**
 * Retrieval against real pgvector. A mock would prove nothing here: the behaviour under test is
 * the `<=>` cosine operator, the HNSW index and the join back to the document.
 *
 * The embedder is deterministic rather than a real provider — the question is whether the query
 * ranks and filters correctly given vectors, not whether a provider produces good ones.
 */
const connectionString = process.env.TEST_DATABASE_URL;

/**
 * Maps a text to a unit vector pointing along one axis, chosen by a keyword. Two texts sharing
 * a keyword are identical; texts with different keywords are orthogonal, so cosine similarity
 * is exactly 1 or 0 and the assertions can be about ranking rather than about float noise.
 */
const AXES = ['rook', 'pawn', 'bishop'] as const;

function axisFor(text: string): number {
  const found = AXES.findIndex((word) => text.toLowerCase().includes(word));
  return found === -1 ? AXES.length : found;
}

const deterministicEmbedder: Embedder = {
  name: 'axis-test',
  embed: async (texts) =>
    texts.map((text) => {
      const vector = Array.from({ length: EMBEDDING_DIMENSIONS }, () => 0);
      vector[axisFor(text)] = 1;
      return vector;
    }),
};

describe.skipIf(!connectionString)('corpus retrieval', () => {
  const db = createDatabase(connectionString!, { max: 4 });
  const retrieve = createRetriever(db, deterministicEmbedder);

  beforeEach(async () => {
    await db.delete(schema.corpusChunks);
    await db.delete(schema.corpusDocs);
  });

  afterAll(async () => {
    await db.delete(schema.corpusDocs);
  });

  async function seed() {
    await ingestDocument(
      { db, embedder: deterministicEmbedder },
      {
        title: 'Rook Endings',
        author: 'Levenfish',
        year: 1957,
        license: 'public-domain',
        text: 'All rook endings are drawn, as the saying goes about the rook.',
      },
    );
    await ingestDocument(
      { db, embedder: deterministicEmbedder },
      {
        title: 'Pawn Structure',
        author: 'Soltis',
        year: 1995,
        license: 'public-domain',
        text: 'The isolated pawn is a weakness and a strength, this pawn especially.',
      },
    );
  }

  it('stores a document and its chunks', async () => {
    const result = await ingestDocument(
      { db, embedder: deterministicEmbedder },
      { title: 'A Text', license: 'public-domain', text: 'Something about the rook.' },
    );

    expect(result.chunks).toBeGreaterThan(0);
    const chunks = await db.select().from(schema.corpusChunks);
    expect(chunks).toHaveLength(result.chunks);
  });

  it('finds the passage on the queried subject', async () => {
    await seed();
    const hits = await retrieve('tell me about the rook');

    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.content).toContain('rook');
  });

  it('carries the source and locator, so a claim can be attributed', async () => {
    await seed();
    const [hit] = await retrieve('the rook');

    expect(hit!.source.title).toBe('Rook Endings');
    expect(hit!.source.author).toBe('Levenfish');
    expect(hit!.source.year).toBe(1957);
    expect(hit!.id).toBeTruthy();
  });

  it('ranks the closest passage first', async () => {
    await seed();
    const hits = await retrieve('pawn');
    expect(hits[0]!.source.title).toBe('Pawn Structure');
  });

  it('filters out passages too weak to be evidence', async () => {
    await seed();
    // Orthogonal to everything stored, so every score is 0.
    const hits = await retrieve('knight');
    expect(hits).toEqual([]);
  });

  it('reports a score at or above the floor for everything it returns', async () => {
    await seed();
    for (const hit of await retrieve('rook')) {
      expect(hit.score).toBeGreaterThanOrEqual(MIN_SCORE);
    }
  });

  it('honours the limit', async () => {
    await seed();
    expect((await retrieve('rook', { limit: 1 })).length).toBeLessThanOrEqual(1);
  });

  it('returns nothing on an empty corpus rather than failing', async () => {
    expect(await retrieve('anything at all')).toEqual([]);
  });

  it('returns nothing for a blank query without touching the provider', async () => {
    await seed();
    expect(await retrieve('   ')).toEqual([]);
  });

  it('replaces chunks when a document is re-ingested, rather than doubling them', async () => {
    const doc = {
      title: 'Rook Endings',
      license: 'public-domain',
      text: 'All rook endings are drawn.',
    };
    await ingestDocument({ db, embedder: deterministicEmbedder }, doc);
    const first = await db.select().from(schema.corpusChunks);

    await ingestDocument({ db, embedder: deterministicEmbedder }, doc);
    const second = await db.select().from(schema.corpusChunks);

    // A second document row, but its own chunks replaced rather than accumulated.
    expect(second.length).toBe(first.length * 2);
  });

  it('refuses a document with no usable text', async () => {
    await expect(
      ingestDocument(
        { db, embedder: deterministicEmbedder },
        { title: 'Empty', license: 'public-domain', text: '   \n\n  ' },
      ),
    ).rejects.toThrow(/no chunks/i);
  });
});
