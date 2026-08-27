import { desc, eq } from 'drizzle-orm';
import Link from 'next/link';

import { db, schema } from '@chessedu/db';

import { requireUser } from '../../../lib/session';

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

  const recent = await database.query.games.findMany({
    where: eq(schema.games.chessAccountId, account.id),
    orderBy: desc(schema.games.playedAt),
    limit: 20,
  });

  return (
    <div className="space-y-8">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">{account.username}</h1>
        <p className="text-sm text-neutral-500">
          {recent.length === 0
            ? 'Sync queued. Games will appear here as they are pulled in.'
            : `${recent.length} most recent games`}
        </p>
      </div>

      {recent.length > 0 ? (
        <table className="w-full text-sm">
          <thead className="text-left text-neutral-500">
            <tr className="border-b border-neutral-200 dark:border-neutral-800">
              <th className="py-2 font-medium">Date</th>
              <th className="py-2 font-medium">Colour</th>
              <th className="py-2 font-medium">Opponent</th>
              <th className="py-2 font-medium">Opening</th>
              <th className="py-2 font-medium">Result</th>
            </tr>
          </thead>
          <tbody>
            {recent.map((game) => (
              <tr key={game.id} className="border-b border-neutral-100 dark:border-neutral-900">
                <td className="py-2">{game.playedAt.toLocaleDateString()}</td>
                <td className="py-2">{game.userColor === 'w' ? 'White' : 'Black'}</td>
                <td className="py-2">
                  {game.opponentUsername}
                  {game.opponentRating ? ` (${game.opponentRating})` : ''}
                </td>
                <td className="py-2 text-neutral-500">{game.eco ?? '—'}</td>
                <td className="py-2">{game.userResult}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </div>
  );
}
