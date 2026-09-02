import { EMBEDDING_DIMENSIONS, type Embedder, EmbeddingError } from './embed';

/**
 * An embedder for any provider speaking the common `/embeddings` shape:
 * `POST { input: string[], model }` returning `{ data: [{ embedding, index }] }`.
 *
 * Voyage (Anthropic's recommended embeddings partner) and OpenAI both use it, which is why the
 * provider is configuration rather than code. Anthropic has no embeddings API of its own, so
 * this is the one place the project needs a second vendor, and pinning that choice in source
 * would be making the user's decision for them.
 *
 * **The model must return `EMBEDDING_DIMENSIONS` (1536) values.** That width is fixed by
 * `corpus_chunk.embedding` and the HNSW index built on it. A model of a different width needs a
 * schema migration, not a code change here — so a mismatch throws rather than being padded or
 * truncated into something that would rank badly and look fine.
 */

export interface HttpEmbedderConfig {
  /** Full endpoint, e.g. `https://api.voyageai.com/v1/embeddings`. */
  url: string;
  apiKey: string;
  model: string;
  /** Sent when the provider supports it; ignored by those that do not. */
  dimensions?: number;
  fetchImpl?: typeof fetch;
}

interface EmbeddingResponse {
  data?: { embedding?: number[]; index?: number }[];
}

export function httpEmbedder(config: HttpEmbedderConfig): Embedder {
  const fetchImpl = config.fetchImpl ?? globalThis.fetch;

  return {
    name: `${config.model}`,
    async embed(texts) {
      if (texts.length === 0) return [];

      const response = await fetchImpl(config.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify({
          input: texts,
          model: config.model,
          ...(config.dimensions ? { output_dimension: config.dimensions } : {}),
        }),
      });

      if (!response.ok) {
        // The body often says exactly what is wrong (bad model, quota, wrong key).
        const detail = await response.text().catch(() => '');
        throw new EmbeddingError(
          `embedding provider responded ${response.status}${detail ? `: ${detail.slice(0, 300)}` : ''}`,
        );
      }

      const body = (await response.json()) as EmbeddingResponse;
      const data = body.data ?? [];
      if (data.length !== texts.length) {
        throw new EmbeddingError(
          `embedding provider returned ${data.length} vectors for ${texts.length} texts`,
        );
      }

      // `index` is authoritative where present: some providers do not promise input order.
      const ordered: number[][] = new Array(texts.length);
      for (const [position, item] of data.entries()) {
        const at = item.index ?? position;
        if (!item.embedding) throw new EmbeddingError(`embedding ${at} was missing from the response`);
        ordered[at] = item.embedding;
      }

      if (ordered.some((vector) => vector === undefined)) {
        throw new EmbeddingError('embedding provider returned a gap in the response indices');
      }

      return ordered;
    },
  };
}

/**
 * Build an embedder from the environment, or null when none is configured.
 *
 * Null is a supported state, not a failure: the coach runs uncited when the corpus is
 * unavailable, which is better than blocking a game review on a vendor being set up.
 */
export function embedderFromEnv(env: NodeJS.ProcessEnv = process.env): Embedder | null {
  const url = env.EMBEDDING_URL;
  const apiKey = env.EMBEDDING_API_KEY;
  const model = env.EMBEDDING_MODEL;

  if (!url || !apiKey || !model) return null;

  return httpEmbedder({
    url,
    apiKey,
    model,
    dimensions: Number(env.EMBEDDING_DIMENSIONS ?? EMBEDDING_DIMENSIONS),
  });
}
