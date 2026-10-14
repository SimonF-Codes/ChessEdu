'use server';

import { eq } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';

import { db, enqueue, schema } from '@chessedu/db';

import { requireUser } from '../../../lib/session';

/**
 * Ask for the account's history to be pulled again.
 *
 * Until now the only thing that ever queued an ingest was linking the account, so a sync that
 * failed — or data that went missing — left no way back short of unlinking and relinking. The
 * dedupe key still stops a second copy being queued while one is outstanding; since migration
 * 0003 it stops nothing once the job has finished.
 *
 * The account id comes from the session, never from the client.
 */
export async function requestSync(): Promise<{ ok: true } | { ok: false; reason: string }> {
  const user = await requireUser();
  const database = db();

  const account = await database.query.chessAccounts.findFirst({
    where: eq(schema.chessAccounts.userId, user.id),
  });

  if (!account) return { ok: false, reason: 'No Chess.com account is linked.' };
  if (!account.verifiedAt) return { ok: false, reason: 'This account is not verified yet.' };

  await enqueue(database, {
    kind: 'ingest',
    payload: { chessAccountId: account.id },
    dedupeKey: `ingest:${account.id}`,
    priority: 10,
  });

  revalidatePath('/dashboard');
  return { ok: true };
}
