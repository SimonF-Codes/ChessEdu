'use client';

import { Chess } from 'chess.js';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Chessboard } from 'react-chessboard';

import {
  type LineHistory,
  type PlyAttempt,
  type PlyResult,
  plyLabel,
} from '@chessedu/chess/browser';
import type { ReviewOutcome } from '@chessedu/chess';

import { type RecordLineResult, recordLineAttemptAction } from './actions';

/**
 * Drilling one opening line, move by move.
 *
 * The learner plays their side; the opponent's reply from the stored line is played straight
 * back. A wrong move gets one retry, then the right move is played for them, named, and the line
 * carries on — ending it would throw away every move after the slip (ADR 0006, question 3).
 *
 * The component records what happened on each move and nothing else. It never grades: the
 * server derives the outcome from these per-move results.
 */

export interface DrillCard {
  id: string;
  eco: string;
  name: string;
  learnerColor: 'w' | 'b';
  plies: { ply: number; color: 'w' | 'b'; san: string; uci: string }[];
}

/** How long the opponent's reply waits before appearing, so it reads as a move. */
const REPLY_DELAY_MS = 350;

const OUTCOME_LABELS: Record<ReviewOutcome, string> = {
  again: 'Not there yet',
  hard: 'Got there, with a retry',
  good: 'Clean',
  easy: 'Clean and quick',
};

const RESULT_LABELS: Record<PlyResult, string> = {
  first_try: 'first try',
  second_try: 'second try',
  revealed: 'shown',
  abandoned: 'not played',
};

const RESULT_TONES: Record<PlyResult, string> = {
  first_try: 'text-green-700 dark:text-green-400',
  second_try: 'text-amber-700 dark:text-amber-400',
  revealed: 'text-red-700 dark:text-red-400',
  abandoned: 'text-neutral-500',
};

function applyUci(game: Chess, uci: string): void {
  game.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci.slice(4) || undefined });
}

/** The position after the first `count` plies of the line. */
function positionAfter(line: DrillCard, count: number): string {
  const game = new Chess();
  for (const ply of line.plies.slice(0, count)) applyUci(game, ply.uci);
  return game.fen();
}

export function LineDrill({
  line,
  previous,
  queue,
}: {
  line: DrillCard;
  previous: LineHistory;
  queue: { due: number; unseen: number; total: number };
}) {
  const router = useRouter();

  /** Plies of the line already on the board. */
  const [played, setPlayed] = useState(0);
  const [results, setResults] = useState<PlyAttempt[]>([]);
  const [wrong, setWrong] = useState<string[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [status, setStatus] = useState<'playing' | 'saving' | 'done'>('playing');
  const [report, setReport] = useState<RecordLineResult | null>(null);
  const turnStartedAt = useRef(Date.now());

  const position = positionAfter(line, played);
  const next = line.plies[played];
  const learnerToMove = status === 'playing' && next?.color === line.learnerColor;
  const orientation = line.learnerColor === 'w' ? 'white' : 'black';

  const finish = useCallback(
    async (all: PlyAttempt[]) => {
      setStatus('saving');
      const result = await recordLineAttemptAction({ lineId: line.id, plies: all });
      setReport(result);
      setStatus('done');
    },
    [line.id],
  );

  // The opponent's moves play themselves, whether at the start of a line or after each reply.
  useEffect(() => {
    if (status !== 'playing') return;
    if (!next) {
      void finish(results);
      return;
    }
    if (next.color === line.learnerColor) {
      turnStartedAt.current = Date.now();
      return;
    }
    const timer = setTimeout(() => setPlayed((count) => count + 1), REPLY_DELAY_MS);
    return () => clearTimeout(timer);
  }, [finish, line.learnerColor, next, results, status]);

  /** Close out the learner's current move and move on to the opponent's reply. */
  const complete = useCallback(
    (result: PlyResult, wrongUci: string[]) => {
      if (!next) return;
      setResults((all) => [
        ...all,
        { ply: next.ply, result, elapsedMs: Date.now() - turnStartedAt.current, wrongUci },
      ]);
      setWrong([]);
      setPlayed((count) => count + 1);
    },
    [next],
  );

  const onDrop = useCallback(
    (from: string, to: string): boolean => {
      if (!learnerToMove || !next) return false;

      const game = new Chess(position);
      let move;
      try {
        // Always a queen: no line in an opening book under-promotes, and an illegal move throws.
        move = game.move({ from, to, promotion: 'q' });
      } catch {
        return false;
      }
      const uci = `${move.from}${move.to}${move.promotion ?? ''}`;

      if (uci === next.uci) {
        setMessage(null);
        complete(wrong.length === 0 ? 'first_try' : 'second_try', wrong);
        return true;
      }

      const tried = [...wrong, uci];
      if (tried.length < 2) {
        setWrong(tried);
        setMessage(`Not ${move.san}. One more try.`);
        return false;
      }

      setMessage(`The move was ${plyLabel(next.ply, next.san)}. Carry on from there.`);
      complete('revealed', tried);
      return false;
    },
    [complete, learnerToMove, next, position, wrong],
  );

  const reveal = useCallback(() => {
    if (!learnerToMove || !next) return;
    setMessage(`The move was ${plyLabel(next.ply, next.san)}. Carry on from there.`);
    complete('revealed', wrong);
  }, [complete, learnerToMove, next, wrong]);

  /** Stop here: the move in hand and every one after it are recorded as abandoned. */
  const stop = useCallback(() => {
    if (status !== 'playing') return;
    const remaining = line.plies
      .slice(played)
      .filter((ply) => ply.color === line.learnerColor)
      .map((ply, index) => ({
        ply: ply.ply,
        result: 'abandoned' as const,
        elapsedMs: index === 0 ? Date.now() - turnStartedAt.current : 0,
        wrongUci: index === 0 ? wrong : [],
      }));
    setPlayed(line.plies.length);
    setMessage(null);
    void finish([...results, ...remaining]);
  }, [finish, line.learnerColor, line.plies, played, results, status, wrong]);

  const shownHistory = report?.ok ? report.history : previous;

  return (
    <div className="flex flex-col gap-6 lg:flex-row">
      <div className="w-full max-w-lg">
        <Chessboard
          id={`line-${line.id}`}
          position={position}
          onPieceDrop={onDrop}
          boardOrientation={orientation}
          arePiecesDraggable={learnerToMove}
          animationDuration={200}
        />
      </div>

      <aside className="w-full max-w-sm space-y-5 text-sm">
        <div className="space-y-1">
          <p className="text-xs uppercase tracking-wide text-neutral-500">{line.eco}</p>
          <h2 className="font-semibold">{line.name}</h2>
          <p className="text-neutral-500">
            {queue.due > 0 ? `${queue.due} due` : 'Nothing else due'}
            {queue.unseen > 0 ? ` · ${queue.unseen} not tried yet` : ''} · {queue.total} lines
          </p>
        </div>

        <p className="font-mono text-xs leading-relaxed text-neutral-600 dark:text-neutral-400">
          {line.plies.slice(0, played).map((ply) => (
            <span key={ply.ply}>
              {ply.color === 'w' ? `${Math.ceil(ply.ply / 2)}.` : ''}
              {ply.san}{' '}
            </span>
          ))}
        </p>

        {status === 'playing' ? (
          <div className="space-y-3">
            <p className="text-neutral-600 dark:text-neutral-400">
              {message ?? (learnerToMove ? 'Your move.' : '…')}
            </p>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={reveal}
                disabled={!learnerToMove}
                className="rounded-lg border border-neutral-300 px-4 py-2 text-sm font-medium disabled:opacity-50 dark:border-neutral-700"
              >
                Show me
              </button>
              <button
                type="button"
                onClick={stop}
                className="rounded-lg px-4 py-2 text-sm text-neutral-500 hover:underline"
              >
                Stop
              </button>
            </div>
          </div>
        ) : status === 'saving' ? (
          <p className="text-neutral-500">Recording…</p>
        ) : (
          <div className="space-y-3">
            {message ? <p className="text-neutral-600 dark:text-neutral-400">{message}</p> : null}
            <p className="font-medium">
              {report?.ok ? OUTCOME_LABELS[report.outcome] : 'This attempt could not be recorded.'}
            </p>
            {report?.ok ? (
              <p className="text-neutral-500">
                Back in {report.intervalDays} {report.intervalDays === 1 ? 'day' : 'days'}.
              </p>
            ) : null}
            <button
              type="button"
              onClick={() => router.refresh()}
              className="rounded-lg bg-neutral-900 px-4 py-2 text-sm font-medium text-white dark:bg-white dark:text-neutral-900"
            >
              Next line
            </button>
          </div>
        )}

        <HistoryPanel history={shownHistory} />
      </aside>
    </div>
  );
}

/** Where this line breaks down, from the per-move record — never from a stored summary. */
function HistoryPanel({ history }: { history: LineHistory }) {
  return (
    <div className="space-y-2 border-t border-neutral-200 pt-4 dark:border-neutral-800">
      <p className="font-medium">Your record on this line</p>
      <p className="text-neutral-600 dark:text-neutral-400">{history.summary}</p>
      {history.attempts > 0 ? (
        <table className="w-full text-left text-xs">
          <thead className="text-neutral-500">
            <tr>
              <th className="py-1 font-normal">Move</th>
              <th className="py-1 font-normal">Last time</th>
              <th className="py-1 text-right font-normal">First try</th>
            </tr>
          </thead>
          <tbody>
            {history.plies.map((ply) => (
              <tr key={ply.ply} className="border-t border-neutral-100 dark:border-neutral-900">
                <td className="py-1 font-mono">{ply.label}</td>
                <td className={`py-1 ${ply.lastResult ? RESULT_TONES[ply.lastResult] : ''}`}>
                  {ply.lastResult ? RESULT_LABELS[ply.lastResult] : '—'}
                  {ply.missStreak >= 2 ? ` · ${ply.missStreak} in a row` : ''}
                </td>
                <td className="py-1 text-right tabular-nums">
                  {ply.firstTry}/{ply.attempts}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </div>
  );
}
