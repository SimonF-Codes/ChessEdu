import { describe, expect, it, vi } from 'vitest';

import {
  EMBEDDING_DIMENSIONS,
  type Embedder,
  EmbeddingError,
  assertEmbeddings,
  embedAll,
} from './embed';

const vector = (fill = 0.1) => Array.from({ length: EMBEDDING_DIMENSIONS }, () => fill);

function embedderReturning(
  impl: (texts: readonly string[]) => number[][],
  name = 'test',
): Embedder {
  return { name, embed: async (texts) => impl(texts) };
}

describe('assertEmbeddings', () => {
  it('accepts vectors of the expected width', () => {
    expect(() => assertEmbeddings([vector(), vector()], EMBEDDING_DIMENSIONS)).not.toThrow();
  });

  it('rejects a vector of the wrong width, naming which one', () => {
    expect(() => assertEmbeddings([vector(), [1, 2, 3]], EMBEDDING_DIMENSIONS)).toThrow(
      /embedding 1 has 3 dimensions/,
    );
  });

  it('rejects a non-finite value, which Postgres would take but nothing could rank', () => {
    const bad = vector();
    bad[5] = Number.NaN;
    expect(() => assertEmbeddings([bad], EMBEDDING_DIMENSIONS)).toThrow(/non-finite/);
  });
});

describe('embedAll', () => {
  it('returns nothing for no input, without calling the provider', async () => {
    const embed = vi.fn(async () => []);
    const result = await embedAll({ name: 'test', embed }, []);
    expect(result).toEqual([]);
    expect(embed).not.toHaveBeenCalled();
  });

  it('batches, because a book is more than one request', async () => {
    const embed = vi.fn(async (texts: readonly string[]) => texts.map(() => vector()));
    await embedAll({ name: 'test', embed }, Array.from({ length: 10 }, (_, i) => `t${i}`), 4);
    expect(embed).toHaveBeenCalledTimes(3);
  });

  it('preserves order across batches, since callers pair by index', async () => {
    const embedder = embedderReturning((texts) =>
      texts.map((text) => vector(Number(text.slice(1)))),
    );
    const result = await embedAll(embedder, ['t1', 't2', 't3', 't4', 't5'], 2);
    expect(result.map((v) => v[0])).toEqual([1, 2, 3, 4, 5]);
  });

  it('fails when the provider returns the wrong number of vectors', async () => {
    const embedder = embedderReturning(() => [vector()]);
    await expect(embedAll(embedder, ['a', 'b'])).rejects.toBeInstanceOf(EmbeddingError);
  });

  it('fails when the provider returns the wrong width', async () => {
    const embedder = embedderReturning((texts) => texts.map(() => [1, 2, 3]));
    await expect(embedAll(embedder, ['a'])).rejects.toThrow(/dimensions/);
  });
});
