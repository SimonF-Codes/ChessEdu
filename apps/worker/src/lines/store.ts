import { and, eq, isNull, notInArray } from 'drizzle-orm';

import type { GeneratedLine } from '@chessedu/chess';
import { type Database, schema } from '@chessedu/db';

/**
 * Writing a generator run into `opening_line`.
 *
 * An upsert keyed by the line, so re-running changes nothing that did not change. A line of the
 * family that this run did not produce — the engine now prefers another move, or the book was
 * refreshed — is retired, not deleted: users' `line_review` and `line_attempt` rows point at it,
 * and their history is worth more than a tidy table. See docs/adr/0006-opening-line-drill.md.
 */
export async function saveGeneratedLines(input: {
  db: Database;
  family: string;
  lines: readonly GeneratedLine[];
  /** What chose the engine moves, e.g. `stockfish depth 20`. */
  engine: string;
  now?: Date;
}): Promise<{ saved: number; retired: number }> {
  const now = input.now ?? new Date();

  // An empty run is a broken engine or a broken spec, never "the opening has no lines".
  if (input.lines.length === 0) throw new Error(`no lines generated for ${input.family}`);
  const stray = input.lines.find((line) => line.family !== input.family);
  if (stray) throw new Error(`line ${stray.key} is family ${stray.family}, not ${input.family}`);

  return input.db.transaction(async (tx) => {
    for (const line of input.lines) {
      const values = {
        family: line.family,
        eco: line.eco,
        name: line.name,
        learnerColor: line.learnerColor,
        plies: line.plies,
        plyCount: line.plies.length,
        engine: input.engine,
        generatedAt: now,
        retiredAt: null,
      };
      await tx
        .insert(schema.openingLines)
        .values({ key: line.key, ...values })
        .onConflictDoUpdate({ target: schema.openingLines.key, set: values });
    }

    const retired = await tx
      .update(schema.openingLines)
      .set({ retiredAt: now })
      .where(
        and(
          eq(schema.openingLines.family, input.family),
          isNull(schema.openingLines.retiredAt),
          notInArray(
            schema.openingLines.key,
            input.lines.map((line) => line.key),
          ),
        ),
      )
      .returning({ id: schema.openingLines.id });

    return { saved: input.lines.length, retired: retired.length };
  });
}
