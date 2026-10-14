import Link from 'next/link';

import { lineFamilyLabel, summariseLineHistory } from '@chessedu/chess';
import { db } from '@chessedu/db';

import {
  type LineFamily,
  type LineIndexEntry,
  loadLineFamilies,
  loadLineHistory,
  loadLineIndex,
  loadLineQueue,
  loadLiveLine,
} from '../../../lib/line-drill';
import { requireUser } from '../../../lib/session';
import { type DrillCard, LineDrill } from './line-drill';

export const metadata = { title: 'Lines — ChessEdu' };

/**
 * Opening line repetition. Which line is next is the pure rule in packages/chess; the lines
 * themselves were chosen by Stockfish and the player's own games, the ECO book only naming them
 * (ADR 0006, ADR 0007, ADR 0009). This page supplies the line and its history, and the board does
 * the rest.
 *
 * `?family=<family>` picks which opening's lines; without it, the first family with a line due,
 * else the first. The families are whatever the generator produced — no opening is named here.
 *
 * `?line=<id>` drills a line picked from the index instead of the queue's. Whether that attempt
 * is graded is decided exactly as for any other — by `isGradedAttempt`, on the server — so
 * picking a line cannot choose a grade. Every line can also be *learnt* first, ungraded, at
 * /lines/learn/<id> (ADR 0008).
 */
export default async function LinesPage({
  searchParams,
}: {
  searchParams: Promise<{ line?: string; family?: string }>;
}) {
  const user = await requireUser();
  const database = db();
  const now = new Date();
  const { line: pickedId, family: requested } = await searchParams;

  const families = await loadLineFamilies({ db: database, userId: user.id, now });
  const current =
    families.find((f) => f.family === requested) ??
    families.find((f) => f.due > 0) ??
    families[0] ??
    null;

  if (!current) {
    return (
      <div className="space-y-6">
        <div className="max-w-2xl space-y-2">
          <h1 className="text-2xl font-semibold tracking-tight">Lines</h1>
        </div>
        <p className="max-w-2xl text-sm text-neutral-600 dark:text-neutral-400">
          No lines have been generated on this deployment yet. They are produced by{' '}
          <code className="font-mono">npm run lines:generate --workspace @chessedu/worker</code>.
        </p>
      </div>
    );
  }

  const family = current.family;
  const [queue, index, picked] = await Promise.all([
    loadLineQueue({ db: database, userId: user.id, family, now }),
    loadLineIndex({ db: database, userId: user.id, family }),
    pickedId ? loadLiveLine({ db: database, family, lineId: pickedId }) : Promise.resolve(null),
  ]);

  const intro = (
    <div className="max-w-2xl space-y-3">
      <h1 className="text-2xl font-semibold tracking-tight">
        Lines — {lineFamilyLabel(family, current.learnerColor)}
      </h1>
      <FamilyPicker families={families} current={family} />
      <p className="text-sm text-neutral-600 dark:text-neutral-400">
        Your opponent&apos;s replies are the ones played against you most often in your own games,
        where Stockfish does not rate them as losing, and others Stockfish rates close to its best;
        every move of yours after the opening&apos;s first moves is Stockfish&apos;s. <em>Learn</em>{' '}
        a line to walk through it with every move explained; <em>drill</em> it until it is automatic
        — a wrong move is corrected and the line carries on, and you can run it again straight away.
      </p>
    </div>
  );

  const line = picked ?? queue.next;

  if (!line) {
    return (
      <div className="space-y-8">
        {intro}
        <div className="max-w-xl space-y-3">
          <p className="font-medium">Nothing due.</p>
          <p className="text-sm text-neutral-600 dark:text-neutral-400">
            You have met all {queue.total} lines, and each comes back on its own schedule.
            {queue.nextDueAt
              ? ` The next one is due ${queue.nextDueAt.toLocaleDateString('en-GB', {
                  weekday: 'long',
                  day: 'numeric',
                  month: 'long',
                })}.`
              : ''}{' '}
            You can still learn or drill any line below.
          </p>
          <Link
            href="/openings"
            className="inline-block rounded-lg bg-neutral-900 px-4 py-2 text-sm font-medium text-white dark:bg-white dark:text-neutral-900"
          >
            See your repertoire
          </Link>
        </div>
        <LineIndex lines={index} current={null} family={family} now={now} />
      </div>
    );
  }

  const attempts = await loadLineHistory({ db: database, userId: user.id, lineId: line.id });

  const card: DrillCard = {
    id: line.id,
    eco: line.eco,
    name: line.name,
    learnerColor: line.learnerColor,
    plies: line.plies.map(({ ply, color, san, uci }) => ({ ply, color, san, uci })),
  };

  return (
    <div className="space-y-8">
      {intro}
      {attempts.length === 0 ? (
        <p className="max-w-2xl rounded-lg border border-neutral-200 px-4 py-3 text-sm dark:border-neutral-800">
          A line you have not seen before.{' '}
          <Link href={`/lines/learn/${line.id}`} className="font-medium underline">
            Learn it first
          </Link>{' '}
          — walk through it with every move explained, nothing graded — or drill it straight away.
        </p>
      ) : null}
      <LineDrill
        key={line.id}
        line={card}
        previous={summariseLineHistory(line, attempts)}
        queue={{ due: queue.due, unseen: queue.unseen, total: queue.total }}
        picked={picked !== null}
      />
      <LineIndex lines={index} current={line.id} family={family} now={now} />
    </div>
  );
}

function statusOf(entry: LineIndexEntry, now: Date): string {
  if (!entry.attempted || !entry.dueAt) return 'new';
  if (entry.dueAt.getTime() <= now.getTime()) return 'due';
  return `due ${entry.dueAt.toISOString().slice(0, 10)}`;
}

/** The families with live lines, each with what is due in it. */
function FamilyPicker({ families, current }: { families: LineFamily[]; current: string }) {
  if (families.length < 2) return null;
  return (
    <nav className="flex flex-wrap gap-2 text-sm">
      {families.map((f) => (
        <Link
          key={f.family}
          href={`/lines?family=${encodeURIComponent(f.family)}`}
          className={`rounded-lg border px-3 py-1 ${
            f.family === current
              ? 'border-neutral-900 font-medium dark:border-white'
              : 'border-neutral-200 hover:border-neutral-400 dark:border-neutral-800'
          }`}
        >
          {lineFamilyLabel(f.family, f.learnerColor)}
          <span className="pl-2 text-xs text-neutral-500 tabular-nums">
            {f.due > 0 ? `${f.due} due` : f.unseen > 0 ? `${f.unseen} new` : `${f.total}`}
          </span>
        </Link>
      ))}
    </nav>
  );
}

/** Every live line of the family, each with Learn beside Drill. */
function LineIndex({
  lines,
  current,
  family,
  now,
}: {
  lines: LineIndexEntry[];
  current: string | null;
  family: string;
  now: Date;
}) {
  return (
    <section className="max-w-3xl space-y-2">
      <h2 className="text-xs font-semibold uppercase tracking-wide text-neutral-500">
        All {lines.length} lines
      </h2>
      <table className="w-full text-left text-sm">
        <tbody>
          {lines.map((entry) => (
            <tr
              key={entry.id}
              className={`border-t border-neutral-100 dark:border-neutral-900 ${
                entry.id === current ? 'bg-neutral-50 dark:bg-neutral-900' : ''
              }`}
            >
              <td className="py-1.5 pr-3">{entry.name}</td>
              <td className="py-1.5 pr-3 text-xs text-neutral-500 tabular-nums">
                {statusOf(entry, now)}
              </td>
              <td className="py-1.5 text-right whitespace-nowrap">
                <Link href={`/lines/learn/${entry.id}`} className="font-medium hover:underline">
                  Learn
                </Link>
                <span className="px-2 text-neutral-300 dark:text-neutral-700">·</span>
                <Link
                  href={`/lines?family=${encodeURIComponent(family)}&line=${entry.id}`}
                  className="font-medium hover:underline"
                >
                  Drill
                </Link>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
