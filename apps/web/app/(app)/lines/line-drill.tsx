'use client';

import { Chess, type Square } from 'chess.js';
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
 * back. A wrong move gets one retry; after a second, or "Show me", the right move is played,
 * taken back, and the learner must play it themselves before the line carries on (ADR 0007,
 * reopening ADR 0006 question 3). The line is always completed.
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

/** How long a revealed move stays on the board before it is taken back for the learner to play. */
const SHOW_MOVE_MS = 900;

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

function daysLabel(days: number): string {
  return `${days} ${days === 1 ? 'day' : 'days'}`;
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
  /** The record as of the last attempt saved here, so it stays current across replays. */
  const [history, setHistory] = useState(previous);
  /**
   * Set once the current move has been revealed: what the record will say about it, frozen at
   * the moment of the reveal. The line does not move on until the learner plays the move
   * themselves (ADR 0007, replacing ADR 0006 question 3's "played for them").
   */
  const [shown, setShown] = useState<{ elapsedMs: number; wrongUci: string[] } | null>(null);
  /** While true the revealed move is on the board; then it is taken back for the learner. */
  const [demonstrating, setDemonstrating] = useState(false);
  const turnStartedAt = useRef(Date.now());

  const position = positionAfter(line, demonstrating ? played + 1 : played);
  const next = line.plies[played];
  const learnerToMove = status === 'playing' && !demonstrating && next?.color === line.learnerColor;
  const orientation = line.learnerColor === 'w' ? 'white' : 'black';
  /** Something has gone wrong in this attempt, so starting over mid-line is worth offering. */
  const slipped =
    shown !== null || wrong.length > 0 || results.some((r) => r.result !== 'first_try');

  /** Back to move one for a fresh attempt. The one before it is already recorded. */
  const reset = useCallback(() => {
    setPlayed(0);
    setResults([]);
    setWrong([]);
    setShown(null);
    setDemonstrating(false);
    setMessage(null);
    setReport(null);
    setStatus('playing');
  }, []);

  /**
   * Record the attempt, then either show how it went or — for a restart — go straight back to
   * move one. Every attempt is its own record; a replay never replaces the one before (ADR 0007).
   */
  const finish = useCallback(
    async (all: PlyAttempt[], then: 'report' | 'replay' = 'report') => {
      setStatus('saving');
      const result = await recordLineAttemptAction({ lineId: line.id, plies: all });
      if (result.ok) setHistory(result.history);
      if (then === 'replay') {
        reset();
        return;
      }
      setReport(result);
      setStatus('done');
    },
    [line.id, reset],
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
    (result: PlyResult, wrongUci: string[], elapsedMs = Date.now() - turnStartedAt.current) => {
      if (!next) return;
      setResults((all) => [...all, { ply: next.ply, result, elapsedMs, wrongUci }]);
      setWrong([]);
      setShown(null);
      setPlayed((count) => count + 1);
    },
    [next],
  );

  /**
   * Reveal the move: play it, take it back, and wait for the learner to play it. It is recorded
   * as `revealed` whatever happens next — finding it now is copying, not recall.
   */
  const showMove = useCallback(
    (tried: string[]) => {
      if (!next) return;
      setShown({ elapsedMs: Date.now() - turnStartedAt.current, wrongUci: tried });
      setWrong([]);
      setDemonstrating(true);
      setMessage(`The move is ${plyLabel(next.ply, next.san)}. Now you play it.`);
    },
    [next],
  );

  // A revealed move stays on the board just long enough to be seen, then is taken back.
  useEffect(() => {
    if (!demonstrating) return;
    const timer = setTimeout(() => setDemonstrating(false), SHOW_MOVE_MS);
    return () => clearTimeout(timer);
  }, [demonstrating]);

  const onDrop = useCallback(
    (from: string, to: string): boolean => {
      if (!learnerToMove || !next) return false;
      if (shown) {
        // After a reveal, only the move itself moves the line on; nothing more is recorded.
        if (`${from}${to}` !== next.uci.slice(0, 4)) {
          setMessage(`Not that — play ${plyLabel(next.ply, next.san)}.`);
          return false;
        }
        setMessage(null);
        complete('revealed', shown.wrongUci, shown.elapsedMs);
        return true;
      }

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

      showMove(tried);
      return false;
    },
    [complete, learnerToMove, next, position, showMove, shown, wrong],
  );

  const reveal = useCallback(() => {
    if (!learnerToMove || !next || shown) return;
    showMove(wrong);
  }, [learnerToMove, next, showMove, shown, wrong]);

  /**
   * Stop here: the move in hand and every one after it are recorded as abandoned. Then either
   * show the result, or — "Start again" — begin a new attempt at once.
   */
  const stop = useCallback(
    (then: 'report' | 'replay' = 'report') => {
      if (status !== 'playing') return;
      const remaining = line.plies
        .slice(played)
        .filter((ply) => ply.color === line.learnerColor)
        .map((ply, index) => ({
          ply: ply.ply,
          result: 'abandoned' as const,
          elapsedMs: index === 0 ? Date.now() - turnStartedAt.current : 0,
          wrongUci: index === 0 ? (shown?.wrongUci ?? wrong) : [],
        }));
      setPlayed(line.plies.length);
      setMessage(null);
      void finish([...results, ...remaining], then);
    },
    [finish, line.learnerColor, line.plies, played, results, shown, status, wrong],
  );

  return (
    <div className="flex flex-col gap-6 lg:flex-row">
      <div className="w-full max-w-lg">
        <Chessboard
          id={`line-${line.id}`}
          position={position}
          onPieceDrop={onDrop}
          boardOrientation={orientation}
          arePiecesDraggable={learnerToMove}
          customArrows={
            shown && !demonstrating && next
              ? [[next.uci.slice(0, 2) as Square, next.uci.slice(2, 4) as Square]]
              : []
          }
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
                disabled={!learnerToMove || shown !== null}
                className="rounded-lg border border-neutral-300 px-4 py-2 text-sm font-medium disabled:opacity-50 dark:border-neutral-700"
              >
                Show me
              </button>
              {slipped ? (
                <button
                  type="button"
                  onClick={() => stop('replay')}
                  className="rounded-lg border border-neutral-300 px-4 py-2 text-sm font-medium dark:border-neutral-700"
                >
                  Start again
                </button>
              ) : null}
              <button
                type="button"
                onClick={() => stop()}
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
              {report?.ok
                ? `${report.graded ? '' : 'Practice — '}${OUTCOME_LABELS[report.outcome]}`
                : 'This attempt could not be recorded.'}
            </p>
            {report?.ok ? (
              <p className="text-neutral-500">
                {report.graded
                  ? `Back in ${daysLabel(report.intervalDays)}.`
                  : `Not graded — the first run set the schedule, still back in ${daysLabel(report.intervalDays)}.`}
              </p>
            ) : null}
            <div className="flex gap-2">
              <button
                type="button"
                onClick={reset}
                className="rounded-lg border border-neutral-300 px-4 py-2 text-sm font-medium dark:border-neutral-700"
              >
                Try this line again
              </button>
              <button
                type="button"
                onClick={() => router.refresh()}
                className="rounded-lg bg-neutral-900 px-4 py-2 text-sm font-medium text-white dark:bg-white dark:text-neutral-900"
              >
                Next line
              </button>
            </div>
          </div>
        )}

        <HistoryPanel history={history} />
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
      {history.practice > 0 ? (
        <p className="text-xs text-neutral-500">
          Last {history.attempts} runs, {history.practice} of them practice replays.
        </p>
      ) : null}
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
