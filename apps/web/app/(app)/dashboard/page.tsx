import { eq } from 'drizzle-orm';
import Link from 'next/link';

import { STRENGTH_WINDOW } from '@chessedu/chess';
import { db, schema } from '@chessedu/db';

import { requireUser } from '../../../lib/session';
import { loadStrengthDashboard } from '../../../lib/strength';
import { StrengthPanel } from './strength-panel';

/**
 * The dashboard is the strength model: which phase of the game the player is actually losing
 * points in, and therefore what to work on. A list of games is the evidence underneath it, not
 * the point of the page.
 *
 * Every figure shown is Stockfish output read out of `game_analysis` — see the coaching
 * boundary in section 6 of docs/architecture.md, and the model in section 9.
 */

const RESULT_LABELS: Record<'win' | 'loss' | 'draw', string> = {
  win: 'Won',
  loss: 'Lost',
  draw: 'Drew',
};

export default async function DashboardPage() {
  const user = await requireUser();
  const database = db();

  const account = await database.query.chessAccounts.findFirst({
    where: eq(schema.chessAccounts.userId, user.id),
  });

  if (!account) {
    return (
      <div className="max-w-xl space-y-4">
        <h1 className="text-2xl font-semibold tracking-tight">Nothing to study yet</h1>
        <p className="text-sm text-neutral-600 dark:text-neutral-400">
          Link your Chess.com account and ChessEdu will pull your history and start analysing it.
        </p>
        <Link
          href="/link"
          className="inline-block rounded-lg bg-neutral-900 px-4 py-2 text-sm font-medium text-white dark:bg-white dark:text-neutral-900"
        >
          Link Chess.com
        </Link>
      </div>
    );
  }

  const dashboard = await loadStrengthDashboard(database, account.id);

  if (dashboard.games === 0) {
    return (
      <div className="max-w-xl space-y-4">
        <h1 className="text-2xl font-semibold tracking-tight">{account.username}</h1>
        <p className="text-sm text-neutral-600 dark:text-neutral-400">
          Sync queued. Your games will appear here as they are pulled in, and the engine starts on
          each one as it lands.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-10">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">{account.username}</h1>
        <p className="text-sm text-neutral-500">
          Last {Math.min(dashboard.games, STRENGTH_WINDOW)} games
          {dashboard.pendingGames > 0
            ? ` · ${dashboard.pendingGames} still waiting on the engine`
            : ''}
        </p>
      </div>

      {dashboard.analysedGames === 0 ? (
        <p className="rounded-xl border border-neutral-200 p-4 text-sm text-neutral-600 dark:border-neutral-800 dark:text-neutral-400">
          The engine has not finished a game yet. Your strength by phase appears here as soon as the
          first analysis lands.
        </p>
      ) : (
        <StrengthPanel profile={dashboard.profile} />
      )}

      <section className="space-y-4">
        <h2 className="text-lg font-medium">Recent games</h2>
        <table className="w-full text-sm">
          <thead className="text-left text-neutral-500">
            <tr className="border-b border-neutral-200 dark:border-neutral-800">
              <th className="py-2 font-medium">Date</th>
              <th className="py-2 font-medium">Colour</th>
              <th className="py-2 font-medium">Opponent</th>
              <th className="py-2 font-medium">Opening</th>
              <th className="py-2 font-medium">Result</th>
              <th className="py-2 text-right font-medium">Accuracy</th>
            </tr>
          </thead>
          <tbody>
            {dashboard.recent.map((game) => (
              <tr key={game.id} className="border-b border-neutral-100 dark:border-neutral-900">
                <td className="py-2">
                  <a href={game.url} className="hover:underline">
                    {game.playedAt.toLocaleDateString()}
                  </a>
                </td>
                <td className="py-2">{game.userColor === 'w' ? 'White' : 'Black'}</td>
                <td className="py-2">
                  {game.opponentUsername}
                  {game.opponentRating ? ` (${game.opponentRating})` : ''}
                </td>
                <td className="py-2 text-neutral-500">{game.eco ?? '—'}</td>
                <td className="py-2">{RESULT_LABELS[game.userResult]}</td>
                <td className="py-2 text-right tabular-nums text-neutral-500">
                  {game.accuracy === null ? 'analysing' : `${game.accuracy.toFixed(1)}%`}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}
