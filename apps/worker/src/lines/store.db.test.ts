import { eq, like } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import type { GeneratedLine } from '@chessedu/chess';
import { createDatabase, schema } from '@chessedu/db';

import { saveGeneratedLines } from './store';

/**
 * Re-running the generator is an upsert keyed by the line, and a line a later run no longer
 * produces is retired rather than deleted, so a user's history with it survives. Real Postgres;
 * skipped without TEST_DATABASE_URL. Touches only its own family, never the real lines.
 */
const connectionString = process.env.TEST_DATABASE_URL;

const FAMILY = 'test-line-store';

function line(key: string, name = 'Ponziani Opening'): GeneratedLine {
  return {
    key: `${FAMILY}:${key}`,
    family: FAMILY,
    eco: 'C44',
    name,
    learnerColor: 'w',
    plies: [
      {
        ply: 1,
        color: 'w',
        san: 'e4',
        uci: 'e2e4',
        fenBefore: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
        source: 'opening',
      },
    ],
  };
}

describe.skipIf(!connectionString)('saveGeneratedLines', () => {
  const db = createDatabase(connectionString!, { max: 2 });
  const NOW = new Date('2026-09-28T12:00:00.000Z');
  const LATER = new Date('2026-10-28T12:00:00.000Z');

  const cleanUp = async () => {
    await db.delete(schema.openingLines).where(like(schema.openingLines.family, 'test-%'));
  };

  beforeEach(cleanUp);
  afterAll(cleanUp);

  const rows = () =>
    db
      .select()
      .from(schema.openingLines)
      .where(eq(schema.openingLines.family, FAMILY))
      .orderBy(schema.openingLines.key);

  it('inserts every line with its provenance', async () => {
    const result = await saveGeneratedLines({
      db,
      family: FAMILY,
      lines: [line('a'), line('b')],
      engine: 'stockfish depth 20',
      now: NOW,
    });
    expect(result).toEqual({ saved: 2, retired: 0 });

    const stored = await rows();
    expect(stored).toHaveLength(2);
    expect(stored[0]).toMatchObject({ engine: 'stockfish depth 20', plyCount: 1, retiredAt: null });
    expect(stored[0]!.plies[0]!.uci).toBe('e2e4');
  });

  it('updates a line in place on a re-run, keeping its id', async () => {
    await saveGeneratedLines({ db, family: FAMILY, lines: [line('a')], engine: 'x', now: NOW });
    const [before] = await rows();

    await saveGeneratedLines({
      db,
      family: FAMILY,
      lines: [line('a', 'Ponziani Opening: Renamed')],
      engine: 'y',
      now: LATER,
    });
    const [after] = await rows();

    expect(after!.id).toBe(before!.id);
    expect(after).toMatchObject({ name: 'Ponziani Opening: Renamed', engine: 'y' });
    expect(after!.generatedAt.getTime()).toBe(LATER.getTime());
  });

  it('retires what a later run no longer produces, and revives what it produces again', async () => {
    await saveGeneratedLines({
      db,
      family: FAMILY,
      lines: [line('a'), line('b')],
      engine: 'x',
      now: NOW,
    });

    const second = await saveGeneratedLines({
      db,
      family: FAMILY,
      lines: [line('a')],
      engine: 'x',
      now: LATER,
    });
    expect(second).toEqual({ saved: 1, retired: 1 });
    let stored = await rows();
    expect(stored.find((r) => r.key.endsWith(':b'))!.retiredAt?.getTime()).toBe(LATER.getTime());

    await saveGeneratedLines({
      db,
      family: FAMILY,
      lines: [line('a'), line('b')],
      engine: 'x',
      now: LATER,
    });
    stored = await rows();
    expect(stored.every((r) => r.retiredAt === null)).toBe(true);
  });

  it('refuses an empty run rather than retiring the whole family', async () => {
    await saveGeneratedLines({ db, family: FAMILY, lines: [line('a')], engine: 'x', now: NOW });
    await expect(
      saveGeneratedLines({ db, family: FAMILY, lines: [], engine: 'x', now: LATER }),
    ).rejects.toThrow(/no lines/);
    expect((await rows())[0]!.retiredAt).toBeNull();
  });

  it('refuses a line that belongs to another family', async () => {
    await expect(
      saveGeneratedLines({ db, family: 'test-other', lines: [line('a')], engine: 'x', now: NOW }),
    ).rejects.toThrow(/family/);
  });
});
