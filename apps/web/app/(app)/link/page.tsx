import { eq } from 'drizzle-orm';

import { db, schema } from '@chessedu/db';

import { requireUser } from '../../../lib/session';
import { unlinkAction } from './actions';
import { LinkForm } from './link-form';

export default async function LinkPage() {
  const user = await requireUser();

  const linked = await db().query.chessAccounts.findMany({
    where: eq(schema.chessAccounts.userId, user.id),
  });

  return (
    <div className="max-w-2xl space-y-8">
      <div className="space-y-2">
        <h1 className="text-2xl font-semibold tracking-tight">Linked accounts</h1>
        <p className="text-sm text-neutral-600 dark:text-neutral-400">
          Chess.com has no public OAuth, so ownership is proved with a one-time code on your
          public profile. ChessEdu only ever reads public data, and never asks for your
          Chess.com password.
        </p>
      </div>

      {linked.length > 0 ? (
        <ul className="space-y-2">
          {linked.map((account) => (
            <li
              key={account.id}
              className="flex items-center justify-between rounded-lg border border-neutral-200 px-4 py-3 dark:border-neutral-800"
            >
              <div className="text-sm">
                <span className="font-medium">{account.username}</span>
                <span className="ml-2 text-neutral-500">
                  {account.verifiedAt ? 'verified' : 'unverified'}
                  {account.lastSyncedAt
                    ? ` · synced ${account.lastSyncedAt.toLocaleDateString()}`
                    : ' · sync pending'}
                </span>
              </div>
              <form action={unlinkAction}>
                <input type="hidden" name="chessAccountId" value={account.id} />
                <button type="submit" className="text-sm text-red-600 hover:underline">
                  Unlink
                </button>
              </form>
            </li>
          ))}
        </ul>
      ) : (
        <LinkForm />
      )}
    </div>
  );
}
