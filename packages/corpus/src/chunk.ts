/**
 * Splitting a text into the passages that get embedded and cited.
 *
 * Pure and I/O-free, like `packages/chess`: chunking is a decision about text, and decisions
 * belong somewhere they can be tested without a database or a network.
 *
 * The size is a compromise. Too small and a passage loses the context that makes it mean
 * anything; too large and a citation points at a page rather than a sentence, which is not
 * really a citation. Paragraphs are preferred as boundaries because an author already decided
 * where the ideas end.
 */

/** Target characters per chunk. Roughly a long paragraph. */
export const CHUNK_TARGET = 1200;

/** Characters repeated from the previous chunk, so an idea split down the middle survives. */
export const CHUNK_OVERLAP = 150;

/** Below this a trailing fragment is folded back rather than emitted on its own. */
const MIN_CHUNK = 200;

export interface Chunk {
  ordinal: number;
  content: string;
  /** Citable location in the source, e.g. "ch. 4, p. 91". Null when the source has none. */
  locator: string | null;
}

export interface ChunkOptions {
  /** Given a paragraph index, the locator to record for chunks drawn from it. */
  locatorFor?: (paragraphIndex: number) => string | null;
  target?: number;
  overlap?: number;
}

/** Collapse runs of whitespace so a quoted passage reads cleanly. */
function normalise(text: string): string {
  return text.replace(/\s+/gu, ' ').trim();
}

/**
 * The last `overlap` characters, cut back to a word boundary.
 *
 * Slicing blindly leaves a fragment like "tic" at the head of the next chunk, which is noise in
 * the text and worse in the embedding. If the tail contains no boundary at all it is one long
 * word, and carrying part of it forward would be meaningless, so nothing is carried.
 */
function wordSafeTail(content: string, overlap: number): string {
  if (overlap <= 0) return '';
  if (content.length <= overlap) return content;

  const tail = content.slice(-overlap);
  const boundary = tail.search(/\s/u);
  return boundary === -1 ? '' : tail.slice(boundary + 1);
}

/**
 * Break an over-long paragraph on sentence ends, falling back to word boundaries. A word is
 * never split: a half-word helps neither the reader nor the embedding.
 */
function splitLongParagraph(text: string, target: number): string[] {
  const sentences = text.match(/[^.!?]+[.!?]+(?:\s|$)|[^.!?]+$/gu) ?? [text];
  const parts: string[] = [];
  let current = '';

  for (const sentence of sentences) {
    if (current && current.length + sentence.length > target) {
      parts.push(current.trim());
      current = '';
    }

    if (sentence.length > target) {
      // One sentence longer than a whole chunk: fall back to words.
      for (const word of sentence.split(/\s+/u).filter(Boolean)) {
        if (current.length + word.length + 1 > target) {
          parts.push(current.trim());
          current = '';
        }
        current += (current ? ' ' : '') + word;
      }
      continue;
    }

    current += sentence;
  }

  if (current.trim()) parts.push(current.trim());
  return parts;
}

export function chunkText(text: string, options: ChunkOptions = {}): Chunk[] {
  const target = options.target ?? CHUNK_TARGET;
  const overlap = options.overlap ?? CHUNK_OVERLAP;

  const paragraphs = text
    .split(/\n\s*\n/u)
    .map((paragraph, index) => ({ index, content: normalise(paragraph) }))
    .filter((paragraph) => paragraph.content.length > 0);

  if (paragraphs.length === 0) return [];

  const chunks: Chunk[] = [];
  let buffer = '';
  let bufferParagraph = 0;

  const flush = () => {
    const content = buffer.trim();
    if (!content) return;
    chunks.push({
      ordinal: chunks.length,
      content,
      locator: options.locatorFor?.(bufferParagraph) ?? null,
    });
    // Carry a tail forward so a passage cut in half is still retrievable from either side.
    buffer = wordSafeTail(content, overlap);
  };

  for (const paragraph of paragraphs) {
    const pieces =
      paragraph.content.length > target
        ? splitLongParagraph(paragraph.content, target)
        : [paragraph.content];

    for (const piece of pieces) {
      if (buffer && buffer.length + piece.length + 1 > target) {
        flush();
        bufferParagraph = paragraph.index;
      }
      if (!buffer) bufferParagraph = paragraph.index;
      buffer += (buffer ? ' ' : '') + piece;
    }
  }

  // The final buffer is whatever the last flush carried plus the tail of the text. Emit it
  // unless it is only the overlap, which would be a duplicate of the chunk before it.
  const remaining = buffer.trim();
  if (remaining && (chunks.length === 0 || remaining.length > Math.min(overlap, MIN_CHUNK))) {
    chunks.push({
      ordinal: chunks.length,
      content: remaining,
      locator: options.locatorFor?.(bufferParagraph) ?? null,
    });
  }

  return chunks;
}
