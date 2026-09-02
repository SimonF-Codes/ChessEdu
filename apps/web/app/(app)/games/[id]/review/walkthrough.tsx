'use client';

import { useCallback, useEffect, useMemo, useState, useTransition } from 'react';
import { Chessboard } from 'react-chessboard';

import {
  type Classification,
  type GameReview,
  type KeyMomentReason,
  type ReviewMove,
  formatEvaluation,
  winPercentOf,
} from '@chessedu/chess/game-review';

import type { MoveComment } from '../../../../../lib/coach';
import { formatCitation } from '../../../../../lib/coach/retrieval';
import { type ExplainResult, explainGameAction } from './actions';

/**
 * Walking a game: board on the left, the game score on the right, and the annotation for
 * wherever you are standing underneath.
 *
 * Every annotation shown here is the deterministic one built from engine output. The coach's
 * prose is fetched on demand and appears *beside* it — never instead of it, so a page with no
 * model call is still a complete review. See the review coach in docs/architecture.md.
 */

const CLASSIFICATION_STYLE: Record<Classification, string> = {
  blunder: 'bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300',
  mistake: 'bg-orange-100 text-orange-800 dark:bg-orange-950 dark:text-orange-300',
  inaccuracy: 'bg-yellow-100 text-yellow-800 dark:bg-yellow-950 dark:text-yellow-300',
  good: 'bg-neutral-100 text-neutral-600 dark:bg-neutral-900 dark:text-neutral-400',
};

const REASON_LABEL: Record<KeyMomentReason, string> = {
  'turning-point': 'turning point',
  blunder: 'blunder',
  mistake: 'mistake',
  inaccuracy: 'inaccuracy',
  critical: 'critical',
};

function accuracyLabel(accuracy: number | null): string {
  return accuracy === null ? '—' : `${accuracy.toFixed(1)}%`;
}

export function GameWalkthrough({
  review,
  playedAtLabel,
}: {
  review: GameReview;
  playedAtLabel: string;
}) {
  // 0 is the starting position; n is the position after the nth ply.
  const [cursor, setCursor] = useState(0);
  const [comments, setComments] = useState<Record<number, MoveComment>>({});
  const [explanation, setExplanation] = useState<ExplainResult | null>(null);
  const [explaining, startExplaining] = useTransition();

  const total = review.moves.length;
  const current: ReviewMove | null = cursor === 0 ? null : (review.moves[cursor - 1] ?? null);
  const position = current === null ? review.startFen : current.fenAfter;

  const step = useCallback(
    (delta: number) => setCursor((at) => Math.min(total, Math.max(0, at + delta))),
    [total],
  );

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return;

      if (event.key === 'ArrowLeft') step(-1);
      else if (event.key === 'ArrowRight') step(1);
      else if (event.key === 'Home') setCursor(0);
      else if (event.key === 'End') setCursor(total);
      else return;
      event.preventDefault();
    }

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [step, total]);

  const whitePercent = useMemo(() => {
    const evaluation = current === null ? null : current.evalAfter;
    return winPercentOf(evaluation) ?? 50;
  }, [current]);

  const explain = () => {
    startExplaining(async () => {
      const result = await explainGameAction(review.gameId);
      setExplanation(result);
      if (result.ok) {
        setComments(Object.fromEntries(result.comments.map((comment) => [comment.ply, comment])));
        const first = result.comments[0];
        if (first) setCursor(first.ply);
      }
    });
  };

  if (total === 0) {
    return (
      <p className="text-sm text-neutral-500">
        This game has no moves stored yet. It will fill in once the sync finishes.
      </p>
    );
  }

  const comment = current === null ? undefined : comments[current.ply];

  return (
    <div className="space-y-6">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">
          {review.perspective === 'w' ? 'White' : 'Black'} vs {review.opponentUsername}
          {review.opponentRating === null ? '' : ` (${review.opponentRating})`}
        </h1>
        <p className="text-sm text-neutral-500">
          {playedAtLabel} · {review.result} · {review.eco ?? 'unknown opening'} · accuracy{' '}
          {accuracyLabel(review.accuracy.player)} to {accuracyLabel(review.accuracy.opponent)}
        </p>
      </header>

      {!review.analysed ? (
        <p className="rounded-lg border border-neutral-200 bg-neutral-50 p-3 text-sm text-neutral-600 dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-400">
          The engine has not reached this game yet. You can walk the moves; the annotations
          appear once analysis finishes.
        </p>
      ) : null}

      <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="space-y-4">
          <div className="mx-auto w-full max-w-lg">
            <Chessboard
              id="review-board"
              position={position}
              boardOrientation={review.perspective === 'w' ? 'white' : 'black'}
              arePiecesDraggable={false}
              animationDuration={120}
              customBoardStyle={{ borderRadius: '0.5rem' }}
            />
          </div>

          <EvalBar percent={whitePercent} label={formatEvaluation(current?.evalAfter ?? null)} />

          <div className="flex items-center justify-center gap-2">
            <NavButton onClick={() => setCursor(0)} disabled={cursor === 0} label="⏮" title="Start" />
            <NavButton onClick={() => step(-1)} disabled={cursor === 0} label="◀" title="Previous" />
            <span className="min-w-24 text-center text-sm tabular-nums text-neutral-500">
              {cursor} / {total}
            </span>
            <NavButton onClick={() => step(1)} disabled={cursor === total} label="▶" title="Next" />
            <NavButton
              onClick={() => setCursor(total)}
              disabled={cursor === total}
              label="⏭"
              title="End"
            />
          </div>

          <AnnotationPanel move={current} comment={comment} />
        </div>

        <aside className="space-y-6">
          <CoachPanel
            explaining={explaining}
            explanation={explanation}
            onExplain={explain}
            analysed={review.analysed}
            momentCount={review.keyMoments.length}
          />

          {review.keyMoments.length > 0 ? (
            <section className="space-y-2">
              <h2 className="text-xs font-semibold uppercase tracking-wide text-neutral-500">
                Key moments
              </h2>
              <ul className="space-y-1">
                {review.keyMoments.map((moment) => {
                  const move = review.moves[moment.ply - 1];
                  if (!move) return null;
                  return (
                    <li key={moment.ply}>
                      <button
                        type="button"
                        onClick={() => setCursor(moment.ply)}
                        className={`w-full rounded-md px-2 py-1 text-left text-sm hover:bg-neutral-100 dark:hover:bg-neutral-900 ${
                          cursor === moment.ply ? 'bg-neutral-100 dark:bg-neutral-900' : ''
                        }`}
                      >
                        <span className="font-mono">
                          {move.label}
                          {move.san}
                        </span>
                        <span className="ml-2 text-neutral-500">{REASON_LABEL[moment.reason]}</span>
                        {comments[moment.ply] ? <span className="ml-1">💬</span> : null}
                      </button>
                    </li>
                  );
                })}
              </ul>
            </section>
          ) : null}

          <MoveList moves={review.moves} cursor={cursor} onSelect={setCursor} comments={comments} />

          <ChapterList review={review} />
        </aside>
      </div>
    </div>
  );
}

function NavButton({
  onClick,
  disabled,
  label,
  title,
}: {
  onClick: () => void;
  disabled: boolean;
  label: string;
  title: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-label={title}
      className="rounded-md border border-neutral-200 px-3 py-1 text-sm disabled:opacity-40 hover:enabled:bg-neutral-100 dark:border-neutral-800 dark:hover:enabled:bg-neutral-900"
    >
      {label}
    </button>
  );
}

/** White's share of the expected score, straight from the engine evaluation. */
function EvalBar({ percent, label }: { percent: number; label: string }) {
  return (
    <div className="mx-auto flex w-full max-w-lg items-center gap-3">
      <div
        className="h-2 flex-1 overflow-hidden rounded-full bg-neutral-800"
        role="img"
        aria-label={`Evaluation ${label}`}
      >
        <div className="h-full bg-neutral-100" style={{ width: `${percent}%` }} />
      </div>
      <span className="w-14 text-right font-mono text-sm tabular-nums text-neutral-500">
        {label}
      </span>
    </div>
  );
}

function AnnotationPanel({
  move,
  comment,
}: {
  move: ReviewMove | null;
  comment: MoveComment | undefined;
}) {
  if (move === null) {
    return (
      <div className="rounded-lg border border-neutral-200 p-4 text-sm text-neutral-500 dark:border-neutral-800">
        Starting position. Use ← and → to walk the game.
      </div>
    );
  }

  return (
    <div className="space-y-3 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-lg">
          {move.label}
          {move.san}
        </span>
        <span
          className={`rounded-full px-2 py-0.5 text-xs font-medium ${CLASSIFICATION_STYLE[move.classification]}`}
        >
          {move.classification}
        </span>
        <span className="text-xs uppercase tracking-wide text-neutral-500">{move.phase}</span>
        {move.isCritical ? (
          <span className="text-xs font-medium text-neutral-500">critical</span>
        ) : null}
      </div>

      {/* Engine facts. Deterministic, and present whether or not the coach was asked. */}
      <p className="text-sm text-neutral-700 dark:text-neutral-300">{move.annotation}</p>

      {move.bestLineSan.length > 0 ? (
        <p className="font-mono text-xs text-neutral-500">
          Engine line: {move.bestLineSan.join(' ')}
        </p>
      ) : null}

      {comment ? (
        <div className="space-y-2 border-t border-neutral-200 pt-3 dark:border-neutral-800">
          <p className="text-xs font-semibold uppercase tracking-wide text-neutral-500">Coach</p>
          <p className="text-sm leading-relaxed">{comment.comment}</p>
          {comment.citations.length > 0 ? (
            <ul className="space-y-0.5 text-xs text-neutral-500">
              {comment.citations.map((citation) => (
                <li key={citation.chunkId}>— {formatCitation(citation)}</li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function CoachPanel({
  explaining,
  explanation,
  onExplain,
  analysed,
  momentCount,
}: {
  explaining: boolean;
  explanation: ExplainResult | null;
  onExplain: () => void;
  analysed: boolean;
  momentCount: number;
}) {
  return (
    <section className="space-y-2">
      <button
        type="button"
        onClick={onExplain}
        disabled={explaining || !analysed || momentCount === 0}
        className="w-full rounded-lg bg-neutral-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-40 dark:bg-white dark:text-neutral-900"
      >
        {explaining
          ? 'Thinking…'
          : momentCount === 0
            ? 'Nothing to explain'
            : `Explain ${momentCount} key moment${momentCount === 1 ? '' : 's'}`}
      </button>
      {explanation && !explanation.ok ? (
        <p className="text-xs text-red-600 dark:text-red-400">{explanation.message}</p>
      ) : null}
      {explanation?.ok ? (
        <p className="text-xs text-neutral-500">
          {explanation.comments.length} moment
          {explanation.comments.length === 1 ? '' : 's'} explained. They are marked 💬 below.
        </p>
      ) : null}
    </section>
  );
}

function MoveList({
  moves,
  cursor,
  onSelect,
  comments,
}: {
  moves: readonly ReviewMove[];
  cursor: number;
  onSelect: (ply: number) => void;
  comments: Record<number, MoveComment>;
}) {
  return (
    <section className="space-y-2">
      <h2 className="text-xs font-semibold uppercase tracking-wide text-neutral-500">Moves</h2>
      <ol className="max-h-96 space-y-0.5 overflow-y-auto pr-1 font-mono text-sm">
        {moves.map((move) => (
          <li key={move.ply}>
            <button
              type="button"
              onClick={() => onSelect(move.ply)}
              className={`flex w-full items-baseline gap-2 rounded px-2 py-0.5 text-left hover:bg-neutral-100 dark:hover:bg-neutral-900 ${
                cursor === move.ply ? 'bg-neutral-100 dark:bg-neutral-900' : ''
              }`}
            >
              <span className="w-12 shrink-0 text-neutral-400">{move.label}</span>
              <span className={move.byPlayer ? 'font-semibold' : ''}>{move.san}</span>
              {move.classification !== 'good' ? (
                <span
                  className={`ml-auto rounded px-1 text-[10px] ${CLASSIFICATION_STYLE[move.classification]}`}
                >
                  {move.classification.slice(0, 3)}
                </span>
              ) : null}
              {comments[move.ply] ? <span className="ml-1">💬</span> : null}
            </button>
          </li>
        ))}
      </ol>
    </section>
  );
}

function ChapterList({ review }: { review: GameReview }) {
  if (!review.analysed) return null;

  return (
    <section className="space-y-2">
      <h2 className="text-xs font-semibold uppercase tracking-wide text-neutral-500">Phases</h2>
      <ul className="space-y-1 text-sm">
        {review.chapters.map((chapter) => (
          <li key={`${chapter.phase}-${chapter.fromPly}`} className="flex justify-between gap-2">
            <span className="capitalize text-neutral-600 dark:text-neutral-400">
              {chapter.phase}
            </span>
            <span className="text-neutral-500 tabular-nums">
              {accuracyLabel(chapter.playerAccuracy)}
              {chapter.playerBlunders > 0 ? ` · ${chapter.playerBlunders} blunder` : ''}
              {chapter.playerBlunders > 1 ? 's' : ''}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
