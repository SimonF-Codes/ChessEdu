'use server';

import { revalidatePath } from 'next/cache';

import { ChessComClient } from '@chessedu/chesscom';
import { db } from '@chessedu/db';

import {
  type StartLinkResult,
  type VerifyLinkResult,
  startLink,
  unlinkAccount,
  verifyLink,
} from '../../../lib/link-account';
import { requireUser } from '../../../lib/session';

/**
 * Thin wrappers over lib/link-account.ts. All they add is the session — which is the point:
 * the user id is re-derived here from the cookie and never accepted from the client.
 */

function client(): ChessComClient {
  return new ChessComClient({
    contact: process.env.CHESSCOM_CONTACT ?? 'chessedu@localhost',
  });
}

export async function startLinkAction(
  _previous: StartLinkResult | null,
  formData: FormData,
): Promise<StartLinkResult> {
  const user = await requireUser();
  const username = String(formData.get('username') ?? '');
  return startLink({ db: db(), client: client(), userId: user.id, username });
}

export async function verifyLinkAction(): Promise<VerifyLinkResult> {
  const user = await requireUser();
  const result = await verifyLink({ db: db(), client: client(), userId: user.id });
  if (result.ok) revalidatePath('/dashboard');
  return result;
}

export async function unlinkAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  const chessAccountId = String(formData.get('chessAccountId') ?? '');
  await unlinkAccount({ db: db(), userId: user.id, chessAccountId });
  revalidatePath('/link');
  revalidatePath('/dashboard');
}
