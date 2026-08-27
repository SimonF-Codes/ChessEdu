import { and, desc, eq, isNull } from 'drizzle-orm';

import {
  type ChallengeFailure,
  challengeFailureMessage,
  evaluateChallenge,
  generateLinkNonce,
} from '@chessedu/chess';
import { ChessComClient, isValidUsername, normalizeUsername } from '@chessedu/chesscom';
import { type Database, enqueue, schema } from '@chessedu/db';

/**
 * The Chess.com ownership proof, as plain functions taking a database and a client so they can
 * be tested without Next.js in the way. The server actions in app/(app)/link/actions.ts are
 * thin wrappers that add the session.
 *
 * See docs/chess-com-linking.md for why a nonce is needed at all.
 */

export type LinkError =
  | 'invalid_username'
  | 'unknown_user'
  | 'already_linked'
  | 'no_challenge'
  | ChallengeFailure;

export type StartLinkResult =
  | { ok: true; username: string; nonce: string }
  | { ok: false; error: LinkError; message: string };

export type VerifyLinkResult =
  | { ok: true; username: string; chessAccountId: string }
  | { ok: false; error: LinkError; message: string };

const MESSAGES: Record<LinkError, string> = {
  invalid_username: 'That does not look like a Chess.com username.',
  unknown_user: 'Chess.com has no player with that username.',
  already_linked: 'That Chess.com account is already linked to another ChessEdu user.',
  no_challenge: 'Start the link again to get a code.',
  expired: challengeFailureMessage('expired'),
  already_used: challengeFailureMessage('already_used'),
  too_many_attempts: challengeFailureMessage('too_many_attempts'),
  not_found: challengeFailureMessage('not_found'),
};

function fail(error: LinkError): { ok: false; error: LinkError; message: string } {
  return { ok: false, error, message: MESSAGES[error] };
}

/**
 * Step one: check the username exists, then hand back a nonce for the user to put on their
 * profile. Nothing is linked yet.
 */
export async function startLink(input: {
  db: Database;
  client: ChessComClient;
  userId: string;
  username: string;
}): Promise<StartLinkResult> {
  const username = normalizeUsername(input.username);
  if (!isValidUsername(username)) return fail('invalid_username');

  const profile = await input.client.getProfile(username);
  if (!profile) return fail('unknown_user');

  // A username can only be claimed once, and only by whoever proves it.
  const existing = await input.db.query.chessAccounts.findFirst({
    where: and(
      eq(schema.chessAccounts.platform, 'chesscom'),
      eq(schema.chessAccounts.username, username),
    ),
  });
  if (existing && existing.userId !== input.userId) return fail('already_linked');

  const nonce = generateLinkNonce();
  await input.db.insert(schema.linkChallenges).values({
    userId: input.userId,
    platform: 'chesscom',
    username,
    nonce,
  });

  return { ok: true, username, nonce };
}

/**
 * Step two: read the profile back and check it carries the nonce. On success the account is
 * recorded as verified and a history sync is queued.
 */
export async function verifyLink(input: {
  db: Database;
  client: ChessComClient;
  userId: string;
  now?: Date;
}): Promise<VerifyLinkResult> {
  const now = input.now ?? new Date();

  const challenge = await input.db.query.linkChallenges.findFirst({
    where: and(
      eq(schema.linkChallenges.userId, input.userId),
      isNull(schema.linkChallenges.consumedAt),
    ),
    orderBy: desc(schema.linkChallenges.createdAt),
  });
  if (!challenge) return fail('no_challenge');

  // Count the attempt before doing the work, so a failure loop still burns the budget.
  await input.db
    .update(schema.linkChallenges)
    .set({ attempts: challenge.attempts + 1 })
    .where(eq(schema.linkChallenges.id, challenge.id));

  const profile = await input.client.getProfile(challenge.username);
  if (!profile) return fail('unknown_user');

  const verdict = evaluateChallenge({
    challenge: {
      nonce: challenge.nonce,
      createdAt: challenge.createdAt,
      attempts: challenge.attempts,
      consumedAt: challenge.consumedAt,
    },
    profile: { location: profile.location ?? null, name: profile.name ?? null },
    now,
  });
  if (!verdict.ok) return fail(verdict.reason);

  const [account] = await input.db
    .insert(schema.chessAccounts)
    .values({
      userId: input.userId,
      platform: 'chesscom',
      username: challenge.username,
      platformUserId: String(profile.player_id),
      verifiedAt: now,
      profile,
    })
    .onConflictDoUpdate({
      target: [schema.chessAccounts.platform, schema.chessAccounts.username],
      set: {
        userId: input.userId,
        platformUserId: String(profile.player_id),
        verifiedAt: now,
        profile,
      },
    })
    .returning({ id: schema.chessAccounts.id });

  await input.db
    .update(schema.linkChallenges)
    .set({ consumedAt: now })
    .where(eq(schema.linkChallenges.id, challenge.id));

  await enqueue(input.db, {
    kind: 'ingest',
    payload: { chessAccountId: account!.id },
    dedupeKey: `ingest:${account!.id}`,
    priority: 10,
  });

  return { ok: true, username: challenge.username, chessAccountId: account!.id };
}

/** Remove a link and everything derived from it. Games cascade from the account row. */
export async function unlinkAccount(input: {
  db: Database;
  userId: string;
  chessAccountId: string;
}): Promise<void> {
  await input.db
    .delete(schema.chessAccounts)
    .where(
      and(
        eq(schema.chessAccounts.id, input.chessAccountId),
        // Scoped by user id: a stray id from the client can never delete someone else's link.
        eq(schema.chessAccounts.userId, input.userId),
      ),
    );
}
