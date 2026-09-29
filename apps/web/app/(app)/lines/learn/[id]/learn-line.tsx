'use client';

import { Chess, type Square } from 'chess.js';
import Link from 'next/link';
import { type CSSProperties, useCallback, useEffect, useMemo, useState } from 'react';
import { Chessboard } from 'react-chessboard';

import {
  type MoveAnswer,
  type TutorLine,
  type TutorPly,
  askAboutMove,
  buildLineTree,
  explainLine,
  explainPly,
  movesStoredAt,
  plyNote,
  sentence,
} from '@chessedu/chess/tutor';

/**
 * Learn mode: a line walked forward and back, explained at every ply, graded never.
 *
 * Everything the panel says is computed here from the stored line — the authored notes in
 * library.ts, and motif detectors over the board and the ply's stored engine facts. No model, no
 * request. Playing a different move on the board asks the tutor about it; outside the stored
 * lines it says it has not analysed that move, and the move is taken back.
 *
 * Nothing here calls a server action. See docs/adr/0008-computed-tutor-and-learn-mode.md.
 */

export interface LearnLineData {
  id: string;
  name: string;
  eco: string;
  family: string;
  learnerColor: 'w' | 'b';
  plies: TutorPly[];
}

interface SiblingData {
  id: string;
  name: string;
  plies: TutorPly[];
}

interface Probe {
  san: string;
  answer: Exclude<MoveAnswer, { kind: 'this-line' }>;
}

/** The position after the first `count` plies. */
function positionAt(plies: readonly TutorPly[], count: number): string {
  const next = plies[count];
  if (next) return next.fenBefore;
  const last = plies[count - 1];
  if (!last) return new Chess().fen();
  const board = new Chess(last.fenBefore);
  board.move(last.san);
  return board.fen();
}

const LAST_MOVE_STYLE = { backgroundColor: 'rgba(250, 204, 21, 0.35)' };

export function LearnLine({
  line,
  siblings,
  startAt,
}: {
  line: LearnLineData;
  siblings: SiblingData[];
  startAt: number;
}) {
  // 0 is the starting position; n is the position after the nth ply.
  const [cursor, setCursor] = useState(startAt);
  const [probe, setProbe] = useState<Probe | null>(null);

  const total = line.plies.length;
  const tutorLine: TutorLine = useMemo(
    () => ({ family: line.family, learnerColor: line.learnerColor, plies: line.plies }),
    [line],
  );
  const tree = useMemo(() => buildLineTree(siblings), [siblings]);
  const lineNotes = useMemo(() => explainLine(tutorLine), [tutorLine]);
  const position = positionAt(line.plies, cursor);

  const go = useCallback(
    (to: number) => {
      setProbe(null);
      setCursor(Math.min(total, Math.max(0, to)));
    },
    [total],
  );

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return;

      if (event.key === 'ArrowLeft') go(cursor - 1);
      else if (event.key === 'ArrowRight') go(cursor + 1);
      else if (event.key === 'Home') go(0);
      else if (event.key === 'End') go(total);
      else return;
      event.preventDefault();
    }

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [cursor, go, total]);

  const onDrop = (from: Square, to: Square, piece: string): boolean => {
    const board = new Chess(position);
    const promotes = piece[1] === 'P' && (to[1] === '8' || to[1] === '1');
    let move;
    try {
      move = board.move({ from, to, promotion: promotes ? 'q' : undefined });
    } catch {
      return false;
    }

    const answer = askAboutMove(tree, {
      lineId: line.id,
      fen: position,
      uci: `${move.from}${move.to}${move.promotion ?? ''}`,
    });
    if (answer.kind === 'this-line') {
      go(answer.index + 1);
      return true;
    }
    // Anything else is taken back: the board stays on the line.
    setProbe({ san: move.san, answer });
    return false;
  };

  const index = cursor - 1;
  const current = index >= 0 ? line.plies[index] : undefined;
  const lastMoveStyles: Record<string, CSSProperties> = current
    ? { [current.uci.slice(0, 2)]: LAST_MOVE_STYLE, [current.uci.slice(2, 4)]: LAST_MOVE_STYLE }
    : {};

  return (
    <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_24rem]">
      <div className="space-y-4">
        <header className="space-y-1">
          <p className="text-xs uppercase tracking-wide text-neutral-500">{line.eco} · Learn</p>
          <h1 className="text-2xl font-semibold tracking-tight">{line.name}</h1>
          <p className="text-sm text-neutral-500">
            Step through the line and read why each move is played. Nothing here is graded or
            recorded. Play a different move on the board to ask about it.
          </p>
        </header>

        <div className="mx-auto w-full max-w-lg">
          <Chessboard
            id={`learn-${line.id}`}
            position={position}
            onPieceDrop={onDrop}
            boardOrientation={line.learnerColor === 'w' ? 'white' : 'black'}
            customSquareStyles={lastMoveStyles}
            animationDuration={150}
            customBoardStyle={{ borderRadius: '0.5rem' }}
          />
        </div>

        <div className="flex items-center justify-center gap-2">
          <NavButton onClick={() => go(0)} disabled={cursor === 0} label="⏮" title="Start" />
          <NavButton
            onClick={() => go(cursor - 1)}
            disabled={cursor === 0}
            label="◀"
            title="Previous"
          />
          <span className="min-w-24 text-center text-sm tabular-nums text-neutral-500">
            {cursor} / {total}
          </span>
          <NavButton
            onClick={() => go(cursor + 1)}
            disabled={cursor === total}
            label="▶"
            title="Next"
          />
          <NavButton onClick={() => go(total)} disabled={cursor === total} label="⏭" title="End" />
        </div>

        {probe ? <ProbePanel probe={probe} siblings={siblings} tree={tree} line={line} /> : null}

        <MovePanel line={tutorLine} index={index} tree={tree} learnerColor={line.learnerColor} />
      </div>

      <aside className="space-y-6 text-sm">
        <LinePanel notes={lineNotes} />
        <MoveList plies={line.plies} cursor={cursor} onSelect={go} learner={line.learnerColor} />
        <div className="space-y-2 border-t border-neutral-200 pt-4 dark:border-neutral-800">
          <p className="text-neutral-500">Ready to be tested on it?</p>
          <Link
            href={`/lines?line=${line.id}`}
            className="inline-block rounded-lg bg-neutral-900 px-4 py-2 text-sm font-medium text-white dark:bg-white dark:text-neutral-900"
          >
            Drill this line
          </Link>
        </div>
      </aside>
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

/** Why this line: the opening's idea and each choice the line makes, from the authored library. */
function LinePanel({ notes }: { notes: ReturnType<typeof explainLine> }) {
  if (notes.kind === 'missing') {
    return (
      <section className="space-y-2">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-neutral-500">The idea</h2>
        <p className="text-neutral-500">
          There are no written notes for this opening yet. The move explanations come from the board
          and the engine alone.
        </p>
      </section>
    );
  }

  return (
    <section className="space-y-3">
      <h2 className="text-xs font-semibold uppercase tracking-wide text-neutral-500">The idea</h2>
      {notes.pendingReview ? (
        <p className="rounded-md bg-amber-50 px-2 py-1 text-xs text-amber-800 dark:bg-amber-950 dark:text-amber-300">
          Draft notes — not yet checked by a strong player.
        </p>
      ) : null}
      <p className="leading-relaxed">{notes.idea}</p>
      {notes.variations.length > 0 ? (
        <ul className="space-y-2">
          {notes.variations.map((variation) => (
            <li key={variation.label} className="leading-relaxed">
              <span className="mr-1 font-mono font-medium">{variation.label}</span>
              {variation.note}
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

/** Why this move: what kind of move it is, the authored note if any, and the motifs. */
function MovePanel({
  line,
  index,
  tree,
  learnerColor,
}: {
  line: TutorLine;
  index: number;
  tree: ReturnType<typeof buildLineTree>;
  learnerColor: 'w' | 'b';
}) {
  const ply = line.plies[index];
  if (!ply) {
    return (
      <div className="rounded-lg border border-neutral-200 p-4 text-sm text-neutral-500 dark:border-neutral-800">
        Starting position. Step forward with → to see the first move and why it is played.
      </div>
    );
  }

  return (
    <div className="space-y-3 rounded-lg border border-neutral-200 p-4 text-sm dark:border-neutral-800">
      <PlyExplanationView
        line={line}
        index={index}
        branchCount={movesStoredAt(tree, ply.fenBefore)}
        whose={ply.color === learnerColor ? 'Your move' : "Opponent's move"}
      />
    </div>
  );
}

function PlyExplanationView({
  line,
  index,
  branchCount,
  whose,
}: {
  line: TutorLine;
  index: number;
  branchCount: number;
  whose: string;
}) {
  const ply = line.plies[index]!;
  const explanation = explainPly(line, index, { branchCount });
  const note = plyNote(line, index);

  return (
    <>
      <div className="flex flex-wrap items-baseline gap-2">
        <span className="font-mono text-lg">{explanation.label}</span>
        <span className="text-xs uppercase tracking-wide text-neutral-500">{whose}</span>
      </div>

      <p className="text-neutral-600 dark:text-neutral-400">{explanation.source}</p>

      {note ? <p className="leading-relaxed">{note}</p> : null}

      {explanation.motifs.length > 0 ? (
        <ul className="list-disc space-y-1 pl-5">
          {explanation.motifs.map((motif) => (
            <li key={motif.id}>{sentence(motif.text)}</li>
          ))}
        </ul>
      ) : null}

      {/* The only numbers on this panel, and every one of them is stored engine output. */}
      <p className="font-mono text-xs text-neutral-500">
        {explanation.evaluation !== null
          ? `Engine, after this move: ${explanation.evaluation} (from White's side)`
          : ply.source === 'opening'
            ? "No engine score: the opening's own moves were never searched."
            : 'No engine facts stored for this move yet.'}
      </p>
    </>
  );
}

/** The tutor's answer about a move the learner tried that is not this line's. */
function ProbePanel({
  probe,
  siblings,
  tree,
  line,
}: {
  probe: Probe;
  siblings: SiblingData[];
  tree: ReturnType<typeof buildLineTree>;
  line: LearnLineData;
}) {
  const { answer } = probe;

  if (answer.kind === 'not-analysed') {
    return (
      <div
        role="status"
        className="space-y-1 rounded-lg border border-neutral-300 bg-neutral-50 p-4 text-sm dark:border-neutral-700 dark:bg-neutral-900"
      >
        <p className="font-mono text-xs text-neutral-500">
          You tried {probe.san}. It was taken back.
        </p>
        <p className="font-medium">{answer.text}</p>
      </div>
    );
  }

  const other = siblings.find((sibling) => sibling.id === answer.lineId);
  const otherLine: TutorLine | null = other
    ? { family: line.family, learnerColor: line.learnerColor, plies: other.plies }
    : null;

  return (
    <div
      role="status"
      className="space-y-3 rounded-lg border border-neutral-300 bg-neutral-50 p-4 text-sm dark:border-neutral-700 dark:bg-neutral-900"
    >
      <p>
        <span className="font-mono">{probe.san}</span> is not this line&apos;s move, but it is
        played in <span className="font-medium">{answer.lineName}</span>.
      </p>
      {otherLine ? (
        <PlyExplanationView
          line={otherLine}
          index={answer.index}
          branchCount={movesStoredAt(tree, answer.ply.fenBefore)}
          whose={answer.ply.color === line.learnerColor ? 'Your move' : "Opponent's move"}
        />
      ) : null}
      <Link
        href={`/lines/learn/${answer.lineId}?ply=${answer.index + 1}`}
        className="inline-block rounded-lg border border-neutral-300 px-3 py-1.5 text-sm font-medium dark:border-neutral-700"
      >
        Learn that line from here
      </Link>
    </div>
  );
}

function MoveList({
  plies,
  cursor,
  onSelect,
  learner,
}: {
  plies: readonly TutorPly[];
  cursor: number;
  onSelect: (to: number) => void;
  learner: 'w' | 'b';
}) {
  return (
    <section className="space-y-2">
      <h2 className="text-xs font-semibold uppercase tracking-wide text-neutral-500">Moves</h2>
      <ol className="flex flex-wrap gap-x-1 gap-y-0.5 font-mono text-sm">
        {plies.map((ply) => (
          <li key={ply.ply}>
            <button
              type="button"
              onClick={() => onSelect(ply.ply)}
              aria-current={cursor === ply.ply ? 'step' : undefined}
              className={`rounded px-1.5 py-0.5 hover:bg-neutral-100 dark:hover:bg-neutral-900 ${
                cursor === ply.ply ? 'bg-neutral-200 dark:bg-neutral-800' : ''
              } ${ply.color === learner ? 'font-semibold' : ''}`}
            >
              {ply.color === 'w' ? `${Math.ceil(ply.ply / 2)}.` : ''}
              {ply.san}
            </button>
          </li>
        ))}
      </ol>
    </section>
  );
}
