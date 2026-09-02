import { asc, eq } from 'drizzle-orm';

import {
  type Classification,
  type Color,
  type Evaluation,
  type Phase,
  type PhaseSample,
  classifyMove,
  gameAccuracy,
  phaseOf,
} from '@chessedu/chess';
import { type Database, schema } from '@chessedu/db';

import type { Engine, PositionAnalysis } from '../engine';

/**
 * Run a game through the engine and write the judgements the education system reads.
 *
 * Everything produced here is engine output or a pure function of it. No model is involved:
 * see the coaching boundary in docs/architecture.md.
 *
 * The per-phase totals written to `game_analysis.phase_breakdown` are the input to the
 * strength model, so their shape is owned by `@chessedu/chess` (PhaseSample) rather than
 * declared here. See section 8 of docs/architecture.md.
 */

export interface AnalyzePayload {
  gameId: string;
}

/** Aggregate one side's per-move results into the numbers stored on the game. */
export function summarize(
  entries: readonly { winPercentLoss: number; centipawnLoss: number; classification: Classification; phase: Phase }[],
): {
  accuracy: number | null;
  acpl: number;
  counts: Record<Classification, number>;
  byPhase: Record<Phase, PhaseSample>;
} {
  const counts: Record<Classification, number> = {
    blunder: 0,
    mistake: 0,
    inaccuracy: 0,
    good: 0,
  };
  for (const entry of entries) counts[entry.classification] += 1;

  const acpl =
    entries.length === 0
      ? 0
      : Math.round(entries.reduce((sum, e) => sum + e.centipawnLoss, 0) / entries.length);

  const phases: Phase[] = ['opening', 'middlegame', 'endgame'];
  const byPhase = Object.fromEntries(
    phases.map((phase) => {
      const inPhase = entries.filter((e) => e.phase === phase);
      return [
        phase,
        {
          moves: inPhase.length,
          accuracy: gameAccuracy(inPhase.map((e) => e.winPercentLoss)),
          averageCentipawnLoss:
            inPhase.length === 0
              ? 0
              : Math.round(inPhase.reduce((sum, e) => sum + e.centipawnLoss, 0) / inPhase.length),
          blunders: inPhase.filter((e) => e.classification === 'blunder').length,
        } satisfies PhaseSample,
      ];
    }),
  ) as Record<Phase, PhaseSample>;

  return {
    accuracy: gameAccuracy(entries.map((e) => e.winPercentLoss)),
    acpl,
    counts,
    byPhase,
  };
}

export async function runAnalyze(
  context: { db: Database; engine: Engine; depth: number; engineName: string },
  payload: AnalyzePayload,
): Promise<{ movesAnalysed: number }> {
  const { db, engine } = context;

  const game = await db.query.games.findFirst({ where: eq(schema.games.id, payload.gameId) });
  if (!game) throw new Error(`no game ${payload.gameId}`);

  const moves = await db
    .select()
    .from(schema.moves)
    .where(eq(schema.moves.gameId, game.id))
    .orderBy(asc(schema.moves.ply));
  if (moves.length === 0) return { movesAnalysed: 0 };

  await engine.newGame();

  // Analyse every position the game passed through, including the one it ended in. A move's
  // "after" evaluation is simply the evaluation of the next position.
  const positions = [...moves.map((m) => m.fenBefore), game.finalFen].filter(
    (fen): fen is string => typeof fen === 'string' && fen.length > 0,
  );

  const analyses: PositionAnalysis[] = [];
  for (const fen of positions) {
    analyses.push(await engine.analyse(fen));
  }

  const rows = moves.map((move, index) => {
    const before: Evaluation = analyses[index]!.evaluation;
    const after: Evaluation = analyses[index + 1]?.evaluation ?? before;
    const judgement = classifyMove({ before, after, mover: move.color as Color });

    return {
      gameId: game.id,
      ply: move.ply,
      color: move.color as Color,
      evalCp: after.cp,
      mateIn: after.mateIn,
      bestMoveUci: analyses[index]!.bestMoveUci,
      pv: analyses[index]!.pv.slice(0, 8),
      centipawnLoss: judgement.centipawnLoss,
      winPercentLoss: judgement.winPercentLoss,
      classification: judgement.classification,
      phase: phaseOf(move.fenBefore, move.ply),
      isCritical: judgement.isCritical,
    };
  });

  await db.delete(schema.moveAnalysis).where(eq(schema.moveAnalysis.gameId, game.id));
  await db.insert(schema.moveAnalysis).values(
    rows.map(({ color: _color, ...row }) => row),
  );

  const white = summarize(rows.filter((r) => r.color === 'w'));
  const black = summarize(rows.filter((r) => r.color === 'b'));

  await db
    .insert(schema.gameAnalysis)
    .values({
      gameId: game.id,
      engine: context.engineName,
      depth: context.depth,
      accuracyWhite: white.accuracy,
      accuracyBlack: black.accuracy,
      acplWhite: white.acpl,
      acplBlack: black.acpl,
      phaseBreakdown: { white: white.byPhase, black: black.byPhase },
      blunderCount: white.counts.blunder + black.counts.blunder,
      mistakeCount: white.counts.mistake + black.counts.mistake,
      inaccuracyCount: white.counts.inaccuracy + black.counts.inaccuracy,
    })
    .onConflictDoUpdate({
      target: schema.gameAnalysis.gameId,
      set: {
        engine: context.engineName,
        depth: context.depth,
        accuracyWhite: white.accuracy,
        accuracyBlack: black.accuracy,
        acplWhite: white.acpl,
        acplBlack: black.acpl,
        phaseBreakdown: { white: white.byPhase, black: black.byPhase },
        blunderCount: white.counts.blunder + black.counts.blunder,
        mistakeCount: white.counts.mistake + black.counts.mistake,
        inaccuracyCount: white.counts.inaccuracy + black.counts.inaccuracy,
        completedAt: new Date(),
      },
    });

  await generatePuzzles(db, game, rows, moves);

  return { movesAnalysed: rows.length };
}

/**
 * Turn the user's own blunders into puzzles: the position they got wrong, with the engine's
 * move as the solution. Only their side, and only when the engine actually offered a move.
 */
async function generatePuzzles(
  db: Database,
  game: typeof schema.games.$inferSelect,
  rows: readonly {
    ply: number;
    color: Color;
    classification: Classification;
    bestMoveUci: string | null;
    phase: Phase;
  }[],
  moves: readonly (typeof schema.moves.$inferSelect)[],
): Promise<void> {
  const account = await db.query.chessAccounts.findFirst({
    where: eq(schema.chessAccounts.id, game.chessAccountId),
  });
  if (!account) return;

  const byPly = new Map(moves.map((move) => [move.ply, move]));
  const candidates = rows.filter(
    (row) =>
      row.color === game.userColor && row.classification === 'blunder' && row.bestMoveUci !== null,
  );
  if (candidates.length === 0) return;

  await db
    .insert(schema.puzzles)
    .values(
      candidates.map((row) => ({
        userId: account.userId,
        gameId: game.id,
        ply: row.ply,
        fen: byPly.get(row.ply)!.fenBefore,
        solutionUci: [row.bestMoveUci!],
        playedUci: byPly.get(row.ply)!.uci,
        themes: [row.phase],
        phase: row.phase,
      })),
    )
    // A re-analysis at a greater depth should not duplicate a puzzle already in rotation.
    .onConflictDoNothing({ target: [schema.puzzles.gameId, schema.puzzles.ply] });
}
