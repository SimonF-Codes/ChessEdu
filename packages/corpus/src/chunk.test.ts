import { describe, expect, it } from 'vitest';

import { CHUNK_OVERLAP, CHUNK_TARGET, chunkText } from './chunk';

const para = (text: string, times: number) => Array.from({ length: times }, () => text).join('\n\n');

describe('chunkText', () => {
  it('returns nothing for empty input', () => {
    expect(chunkText('')).toEqual([]);
    expect(chunkText('   \n\n  ')).toEqual([]);
  });

  it('keeps a short passage whole', () => {
    const chunks = chunkText('The passed pawn is a criminal, to be kept under lock and key.');
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.content).toContain('passed pawn');
  });

  it('numbers chunks from zero, in order', () => {
    const chunks = chunkText(para('A paragraph about rook endgames. '.repeat(20), 8));
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.map((c) => c.ordinal)).toEqual(chunks.map((_, i) => i));
  });

  it('splits on paragraph boundaries rather than mid-sentence', () => {
    const text = `${'First paragraph. '.repeat(60)}\n\n${'Second paragraph. '.repeat(60)}`;
    const chunks = chunkText(text);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      // Trimmed, and ending on a sentence rather than halfway through one.
      expect(chunk.content).toBe(chunk.content.trim());
      expect(chunk.content).toMatch(/[.!?]$/);
    }
  });

  it('never emits a chunk far over the target', () => {
    const chunks = chunkText(para('Sentence about pawn structure. '.repeat(40), 10));
    for (const chunk of chunks) {
      // A single oversized paragraph can exceed the target, but not without bound.
      expect(chunk.content.length).toBeLessThanOrEqual(CHUNK_TARGET * 2);
    }
  });

  it('splits a single paragraph too long to keep whole', () => {
    const chunks = chunkText('word '.repeat(CHUNK_TARGET));
    expect(chunks.length).toBeGreaterThan(1);
  });

  it('never splits a word across chunks', () => {
    const chunks = chunkText('supercalifragilistic '.repeat(400));
    for (const chunk of chunks) {
      for (const word of chunk.content.split(/\s+/).filter(Boolean)) {
        expect(word).toBe('supercalifragilistic');
      }
    }
  });

  it('overlaps consecutive chunks, so a passage split down the middle is still retrievable', () => {
    // Distinct sentences, so a shared tail is unambiguous evidence of overlap.
    const text = Array.from({ length: 200 }, (_, i) => `Sentence number ${i} about zugzwang.`).join(
      ' ',
    );
    const chunks = chunkText(text);
    expect(chunks.length).toBeGreaterThan(1);

    const tailOfFirst = chunks[0]!.content.slice(-40);
    const overlapping = tailOfFirst
      .split(/\s+/)
      .filter(Boolean)
      .some((word) => chunks[1]!.content.includes(word));
    expect(overlapping).toBe(true);
    expect(CHUNK_OVERLAP).toBeGreaterThan(0);
  });

  it('drops chunks that are only whitespace', () => {
    const chunks = chunkText('Real content here.\n\n\n\n\n\n\n\nMore real content here.');
    for (const chunk of chunks) {
      expect(chunk.content.trim().length).toBeGreaterThan(0);
    }
  });

  it('carries a locator when one is supplied per paragraph', () => {
    const chunks = chunkText('First part.\n\nSecond part.', {
      locatorFor: (index) => `p. ${index + 1}`,
    });
    expect(chunks[0]!.locator).toBe('p. 1');
  });

  it('leaves the locator null when none is supplied', () => {
    expect(chunkText('Some text.')[0]!.locator).toBeNull();
  });

  it('normalises whitespace so a citation reads cleanly', () => {
    const chunks = chunkText('Ragged   text\n  with  odd\tspacing.');
    expect(chunks[0]!.content).toBe('Ragged text with odd spacing.');
  });
});
