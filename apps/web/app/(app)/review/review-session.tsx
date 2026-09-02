'use client';

import { Chess } from 'chess.js';
import { useCallback, useMemo, useRef, useState } from 'react';
import { Chessboard } from 'react-chessboard';

import type { ReviewOutcome } from '@chessedu/chess';

import { type GradeReviewResult, gradeReviewAction } from './actions';

/**
 * Replaying your own blunders, one position at a time.
 *
 * The component keeps no opinion about scheduling: it reports what it saw — how many wrong moves,
 * whether the answer was revealed, how long the position took — and the server turns that into an
 * SM-2 grade. See ADR 0002 and packages/chess/src/srs.ts.
 */

/** Just enough of a puzzle to play it. The scheduling columns stay on the server. */
export interface ReviewCard {
  id: string;
  fen: string;
  solutionUci: string[];
  playedUci: string | null;
  themes: string[];
}

type Status = 'playing' | 'solved' | 'failed';

/** How long the opponent's reply waits before appearing, so the answer is visible as a move. */
const REPLY_DELAY_MS = 350;

const OUTCOME_LABELS: Record<ReviewOutcome, string> = {
  again: 'Missed again',
  hard: 'Found it, the hard way',
  good: 'Solved',
  easy: 'Solved instantly',
};

function squaresOf(uci: string): { from: string; to: string; promotion?: string } {
  return {
    from: uci.slice(0, 2),
    to: uci.slice(2, 4),
    promotion: uci.slice(4) || undefined,
  };
}

/** Apply a UCI move to a FEN, or return null if it is not legal there. */
function applyUci(fen: string, uci: string): string | null {
  const game = new Chess(fen);
  try {
    game.move(squaresOf(uci));
  } catch {
    return null;
  }
  return game.fen();
}

function sideToMove(fen: string): 'white' | 'black' {
  return fen.split(' ')[1] === 'b' ? 'black' : 'white';
}

export function ReviewSession({ puzzles, dueCount }: { puzzles: ReviewCard[]; dueCount: number }) {
  const [index, setIndex] = useState(0);
  const puzzle = puzzles[index];

  const [position, setPosition] = useState(puzzle?.fen ?? '');
  const [step, setStep] = useState(0);
  const [wrongAttempts, setWrongAttempts] = useState(0);
  const [status, setStatus] = useState<Status>('playing');
  const [result, setResult] = useState<GradeReviewResult | null>(null);
  /** True while the opponent's reply is still animating in, when the board is not the player's. */
  const [replying, setReplying] = useState(false);
  const startedAt = useRef(Date.now());

  const orientation = useMemo(() => (puzzle ? sideToMove(puzzle.fen) : 'white'), [puzzle]);

  const finish = useCallback(
    async (id: string, outcomeInput: { wrongAttempts: number; revealed: boolean }) => {
      const report = await gradeReviewAction({
        puzzleId: id,
        wrongAttempts: outcomeInput.wrongAttempts,
        revealed: outcomeInput.revealed,
        elapsedMs: Date.now() - startedAt.current,
      });
      setResult(report);
    },
    [],
  );

  const advance = useCallback(() => {
    const next = index + 1;
    setIndex(next);
    setPosition(puzzles[next]?.fen ?? '');
    setStep(0);
    setWrongAttempts(0);
    setStatus('playing');
    setResult(null);
    setReplying(false);
    startedAt.current = Date.now();
  }, [index, puzzles]);

  const reveal = useCallback(() => {
    // Not while the reply is in flight: `position` is a move behind the step counter until it
    // lands, and playing the rest of the line onto it would produce an illegal position.
    if (!puzzle || status !== 'playing' || replying) return;
    let fen = position;
    for (const uci of puzzle.solutionUci.slice(step)) {
      const next = applyUci(fen, uci);
      if (!next) break;
      fen = next;
    }
    setPosition(fen);
    setStep(puzzle.solutionUci.length);
    setStatus('failed');
    void finish(puzzle.id, { wrongAttempts, revealed: true });
  }, [finish, position, puzzle, replying, status, step, wrongAttempts]);

  const onDrop = useCallback(
    (from: string, to: string): boolean => {
      if (!puzzle || status !== 'playing' || replying) return false;

      const game = new Chess(position);
      let played;
      try {
        // Always offer a queen: under-promotion is not a thing a blunder puzzle asks for, and an
        // illegal move throws rather than returning null in chess.js v1.
        played = game.move({ from, to, promotion: 'q' });
      } catch {
        return false;
      }

      const uci = `${played.from}${played.to}${played.promotion ?? ''}`;
      if (uci !== puzzle.solutionUci[step]) {
        const attempts = wrongAttempts + 1;
        setWrongAttempts(attempts);
        // Two misses is a lapse: show the answer rather than letting them brute-force it.
        if (attempts >= 2) {
          setStatus('failed');
          let fen = position;
          for (const move of puzzle.solutionUci.slice(step)) {
            const next = applyUci(fen, move);
            if (!next) break;
            fen = next;
          }
          setPosition(fen);
          setStep(puzzle.solutionUci.length);
          void finish(puzzle.id, { wrongAttempts: attempts, revealed: false });
        }
        return false;
      }

      const afterPlayer = game.fen();
      setPosition(afterPlayer);

      const replyIndex = step + 1;
      const reply = puzzle.solutionUci[replyIndex];
      if (!reply) {
        setStep(replyIndex);
        setStatus('solved');
        void finish(puzzle.id, { wrongAttempts, revealed: false });
        return true;
      }

      // A multi-move line: play the opponent's answer, then wait for the next player move.
      setStep(replyIndex + 1);
      setReplying(true);
      setTimeout(() => {
        const afterReply = applyUci(afterPlayer, reply);
        if (afterReply) setPosition(afterReply);
        setReplying(false);
      }, REPLY_DELAY_MS);
      return true;
    },
    [finish, position, puzzle, replying, status, step, wrongAttempts],
  );

  if (!puzzle) {
    return (
      <div className="max-w-xl space-y-3">
        <h1 className="text-2xl font-semibold tracking-tight">Session done</h1>
        <p className="text-sm text-neutral-600 dark:text-neutral-400">
          {puzzles.length} {puzzles.length === 1 ? 'puzzle' : 'puzzles'} reviewed.
          {dueCount > puzzles.length
            ? ` ${dueCount - puzzles.length} still due — reload for another session.`
            : ' Nothing else is due right now.'}
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-baseline justify-between">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">
            {orientation === 'white' ? 'White' : 'Black'} to play
          </h1>
          <p className="text-sm text-neutral-500">You went wrong here. Find the move you missed.</p>
        </div>
        <p className="text-sm text-neutral-500">
          {index + 1} / {puzzles.length}
          {dueCount > puzzles.length ? ` of ${dueCount} due` : ''}
        </p>
      </div>

      <div className="flex flex-col gap-6 lg:flex-row">
        <div className="w-full max-w-lg">
          <Chessboard
            id={puzzle.id}
            position={position}
            onPieceDrop={onDrop}
            boardOrientation={orientation}
            arePiecesDraggable={status === 'playing' && !replying}
            animationDuration={200}
          />
        </div>

        <aside className="w-full max-w-sm space-y-4 text-sm">
          <div className="flex flex-wrap gap-2">
            {puzzle.themes.map((theme) => (
              <span
                key={theme}
                className="rounded-full bg-neutral-100 px-3 py-1 text-xs text-neutral-600 dark:bg-neutral-900 dark:text-neutral-400"
              >
                {theme}
              </span>
            ))}
          </div>

          {status === 'playing' ? (
            <>
              <p className="text-neutral-600 dark:text-neutral-400">
                {wrongAttempts === 0
                  ? 'Play the move on the board.'
                  : 'Not that one. One more try before the answer.'}
              </p>
              <button
                type="button"
                onClick={reveal}
                disabled={replying}
                className="rounded-lg border border-neutral-300 px-4 py-2 text-sm font-medium dark:border-neutral-700"
              >
                Show the move
              </button>
            </>
          ) : (
            <div className="space-y-3">
              <p
                className={
                  status === 'solved'
                    ? 'font-medium text-green-700 dark:text-green-400'
                    : 'font-medium text-amber-700 dark:text-amber-400'
                }
              >
                {result?.ok
                  ? OUTCOME_LABELS[result.outcome]
                  : status === 'solved'
                    ? 'Solved'
                    : 'The answer is on the board'}
              </p>
              {puzzle.playedUci ? (
                <p className="text-neutral-600 dark:text-neutral-400">
                  You played <code className="font-mono">{puzzle.playedUci}</code>. The engine
                  played <code className="font-mono">{puzzle.solutionUci.join(' ')}</code>.
                </p>
              ) : null}
              {result?.ok ? (
                <p className="text-neutral-500">
                  Back in {result.intervalDays} {result.intervalDays === 1 ? 'day' : 'days'}.
                </p>
              ) : null}
              <button
                type="button"
                onClick={advance}
                className="rounded-lg bg-neutral-900 px-4 py-2 text-sm font-medium text-white dark:bg-white dark:text-neutral-900"
              >
                {index + 1 < puzzles.length ? 'Next puzzle' : 'Finish'}
              </button>
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}
