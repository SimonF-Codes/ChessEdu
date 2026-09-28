import Link from 'next/link';

import { PONZIANI, summariseLineHistory } from '@chessedu/chess';
import { db } from '@chessedu/db';

import { loadLineHistory, loadLineQueue } from '../../../lib/line-drill';
import { requireUser } from '../../../lib/session';
import { type DrillCard, LineDrill } from './line-drill';

export const metadata = { title: 'Lines — ChessEdu' };

/**
 * Opening line repetition. Which line is next is the pure rule in packages/chess; the lines
 * themselves were chosen by Stockfish against the ECO book's branches (ADR 0006). This page
 * supplies the line and its history, and the board does the rest.
 */
export default async function LinesPage() {
  const user = await requireUser();
  const database = db();
  const now = new Date();

  const queue = await loadLineQueue({
    db: database,
    userId: user.id,
    family: PONZIANI.family,
    now,
  });

  const intro = (
    <div className="max-w-2xl space-y-2">
      <h1 className="text-2xl font-semibold tracking-tight">Lines — the Ponziani</h1>
      <p className="text-sm text-neutral-600 dark:text-neutral-400">
        1.e4 e5 2.Nf3 Nc6 3.c3, as White. Black&apos;s replies are the named ones from opening
        theory; every White move after 3.c3 is Stockfish&apos;s. Play the line until it is automatic
        — a wrong move is corrected and the line carries on.
      </p>
    </div>
  );

  if (queue.total === 0) {
    return (
      <div className="space-y-6">
        {intro}
        <p className="max-w-2xl text-sm text-neutral-600 dark:text-neutral-400">
          No lines have been generated on this deployment yet. They are produced by{' '}
          <code className="font-mono">npm run lines:generate --workspace @chessedu/worker</code>.
        </p>
      </div>
    );
  }

  if (!queue.next) {
    return (
      <div className="space-y-6">
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
              : ''}
          </p>
          <Link
            href="/openings"
            className="inline-block rounded-lg bg-neutral-900 px-4 py-2 text-sm font-medium text-white dark:bg-white dark:text-neutral-900"
          >
            See your repertoire
          </Link>
        </div>
      </div>
    );
  }

  const line = queue.next;
  const attempts = await loadLineHistory({ db: database, userId: user.id, lineId: line.id });

  const card: DrillCard = {
    id: line.id,
    eco: line.eco,
    name: line.name,
    learnerColor: line.learnerColor,
    plies: line.plies.map(({ ply, color, san, uci }) => ({ ply, color, san, uci })),
  };

  return (
    <div className="space-y-6">
      {intro}
      <LineDrill
        key={line.id}
        line={card}
        previous={summariseLineHistory(line, attempts)}
        queue={{ due: queue.due, unseen: queue.unseen, total: queue.total }}
      />
    </div>
  );
}
