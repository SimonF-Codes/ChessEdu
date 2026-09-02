import { eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { NONCE_PREFIX } from '@chessedu/chess';
import { ChessComClient } from '@chessedu/chesscom';
import { createDatabase, schema } from '@chessedu/db';

import { startLink, unlinkAccount, verifyLink } from './link-account';

/**
 * Exercised against real Postgres, never a mock — the unique indexes and the upsert are the
 * behaviour under test. CI provides the database; locally this suite is skipped unless
 * TEST_DATABASE_URL is set. See CONTRIBUTING.md.
 */
const connectionString = process.env.TEST_DATABASE_URL;

describe.skipIf(!connectionString)('chess.com account linking', () => {
  const db = createDatabase(connectionString!, { max: 4 });

  /** A client whose fetch returns whatever profile the test wants. */
  function clientReturning(profile: Record<string, unknown> | null) {
    return new ChessComClient({
      contact: 'test@example.com',
      minIntervalMs: 0,
      sleep: () => Promise.resolve(),
      fetchImpl: (async () =>
        profile
          ? new Response(JSON.stringify(profile), {
              status: 200,
              headers: { 'content-type': 'application/json' },
            })
          : new Response('', { status: 404 })) as unknown as typeof fetch,
    });
  }

  const PROFILE = { username: 'jrfx99', player_id: 42, location: 'Berlin' };

  async function makeUser(email: string): Promise<string> {
    const [row] = await db
      .insert(schema.users)
      .values({ email, name: 'Test' })
      .returning({ id: schema.users.id });
    return row!.id;
  }

  let userId: string;

  beforeEach(async () => {
    await db.delete(schema.jobs);
    await db.delete(schema.linkChallenges);
    await db.delete(schema.chessAccounts);
    await db.delete(schema.users);
    userId = await makeUser(`user-${Date.now()}@example.com`);
  });

  afterAll(async () => {
    await db.delete(schema.users);
  });

  describe('startLink', () => {
    it('rejects a malformed username before touching the network', async () => {
      const result = await startLink({
        db,
        client: clientReturning(null),
        userId,
        username: 'no',
      });
      expect(result).toMatchObject({ ok: false, error: 'invalid_username' });
    });

    it('rejects a username Chess.com does not know', async () => {
      const result = await startLink({
        db,
        client: clientReturning(null),
        userId,
        username: 'ghostaccount',
      });
      expect(result).toMatchObject({ ok: false, error: 'unknown_user' });
    });

    it('issues a prefixed nonce and stores the challenge', async () => {
      const result = await startLink({
        db,
        client: clientReturning(PROFILE),
        userId,
        username: 'JrFx99',
      });

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error('unreachable');
      expect(result.nonce.startsWith(NONCE_PREFIX)).toBe(true);
      expect(result.username).toBe('jrfx99');

      const stored = await db.query.linkChallenges.findFirst({
        where: eq(schema.linkChallenges.userId, userId),
      });
      expect(stored?.nonce).toBe(result.nonce);
    });

    it('refuses a username already proved by someone else', async () => {
      const otherUserId = await makeUser('other@example.com');
      await db.insert(schema.chessAccounts).values({
        userId: otherUserId,
        username: 'jrfx99',
        verifiedAt: new Date(),
      });

      const result = await startLink({
        db,
        client: clientReturning(PROFILE),
        userId,
        username: 'jrfx99',
      });
      expect(result).toMatchObject({ ok: false, error: 'already_linked' });
    });
  });

  describe('verifyLink', () => {
    async function beginLink() {
      const started = await startLink({
        db,
        client: clientReturning(PROFILE),
        userId,
        username: 'jrfx99',
      });
      if (!started.ok) throw new Error('setup failed');
      return started.nonce;
    }

    it('fails when no link has been started', async () => {
      const result = await verifyLink({ db, client: clientReturning(PROFILE), userId });
      expect(result).toMatchObject({ ok: false, error: 'no_challenge' });
    });

    it('fails while the profile does not carry the code', async () => {
      await beginLink();
      const result = await verifyLink({ db, client: clientReturning(PROFILE), userId });
      expect(result).toMatchObject({ ok: false, error: 'not_found' });
    });

    it('links the account once the code is on the profile', async () => {
      const nonce = await beginLink();
      const result = await verifyLink({
        db,
        client: clientReturning({ ...PROFILE, location: `Berlin ${nonce}` }),
        userId,
      });

      expect(result).toMatchObject({ ok: true, username: 'jrfx99' });
      const account = await db.query.chessAccounts.findFirst({
        where: eq(schema.chessAccounts.userId, userId),
      });
      expect(account?.verifiedAt).toBeInstanceOf(Date);
      expect(account?.platformUserId).toBe('42');
    });

    it('queues a history sync on success', async () => {
      const nonce = await beginLink();
      await verifyLink({
        db,
        client: clientReturning({ ...PROFILE, location: nonce }),
        userId,
      });

      const jobs = await db.select().from(schema.jobs);
      expect(jobs).toHaveLength(1);
      expect(jobs[0]).toMatchObject({ kind: 'ingest', state: 'pending' });
    });

    it('consumes the challenge so the same code cannot be replayed', async () => {
      const nonce = await beginLink();
      const client = clientReturning({ ...PROFILE, location: nonce });

      await verifyLink({ db, client, userId });
      const second = await verifyLink({ db, client, userId });
      expect(second).toMatchObject({ ok: false, error: 'no_challenge' });
    });

    it('counts a failed attempt, so a polling loop is bounded', async () => {
      await beginLink();
      await verifyLink({ db, client: clientReturning(PROFILE), userId });

      const challenge = await db.query.linkChallenges.findFirst({
        where: eq(schema.linkChallenges.userId, userId),
      });
      expect(challenge?.attempts).toBe(1);
    });

    it('rejects a code that has gone stale', async () => {
      const nonce = await beginLink();
      const result = await verifyLink({
        db,
        client: clientReturning({ ...PROFILE, location: nonce }),
        userId,
        now: new Date(Date.now() + 60 * 60 * 1000),
      });
      expect(result).toMatchObject({ ok: false, error: 'expired' });
    });
  });

  describe('unlinkAccount', () => {
    it('removes the caller own link', async () => {
      const [account] = await db
        .insert(schema.chessAccounts)
        .values({ userId, username: 'jrfx99', verifiedAt: new Date() })
        .returning({ id: schema.chessAccounts.id });

      await unlinkAccount({ db, userId, chessAccountId: account!.id });
      const remaining = await db.select().from(schema.chessAccounts);
      expect(remaining).toHaveLength(0);
    });

    it('will not remove someone else link even given its id', async () => {
      const otherUserId = await makeUser('other2@example.com');
      const [account] = await db
        .insert(schema.chessAccounts)
        .values({ userId: otherUserId, username: 'someone', verifiedAt: new Date() })
        .returning({ id: schema.chessAccounts.id });

      await unlinkAccount({ db, userId, chessAccountId: account!.id });
      const remaining = await db.select().from(schema.chessAccounts);
      expect(remaining).toHaveLength(1);
    });
  });
});
