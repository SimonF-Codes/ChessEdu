import { eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { ChessComClient } from '@chessedu/chesscom';
import { createDatabase, schema } from '@chessedu/db';

import { runIngest } from './ingest';

/**
 * The re-verification gate, against real Postgres.
 *
 * This is the check that stops a stranger's games being attributed to a user after a Chess.com
 * username changes hands, so it is worth testing against the real schema rather than a mock —
 * clearing `verifiedAt` and *not* writing games are both part of the behaviour.
 *
 * CI provides the database; locally this skips unless TEST_DATABASE_URL is set.
 */
const connectionString = process.env.TEST_DATABASE_URL;

describe.skipIf(!connectionString)('ingest re-verification', () => {
  const db = createDatabase(connectionString!, { max: 4 });

  const YEAR_MS = 365 * 24 * 60 * 60 * 1000;

  /**
   * A client that answers the profile lookup with `playerId`, and reports no archives — the
   * archive path is covered elsewhere; what matters here is whether ingest gets that far.
   */
  function clientFor(playerId: number | null) {
    return new ChessComClient({
      contact: 'test@example.com',
      minIntervalMs: 0,
      sleep: () => Promise.resolve(),
      fetchImpl: (async (url: string) => {
        if (playerId === null) return new Response('', { status: 404 });
        const body = url.endsWith('/archives')
          ? { archives: [] }
          : { username: 'jrfx99', player_id: playerId };
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }) as unknown as typeof fetch,
    });
  }

  async function makeAccount(over: Partial<typeof schema.chessAccounts.$inferInsert> = {}) {
    const [user] = await db
      .insert(schema.users)
      .values({ email: `ingest-${crypto.randomUUID()}@example.com`, name: 'Test' })
      .returning({ id: schema.users.id });

    const [account] = await db
      .insert(schema.chessAccounts)
      .values({
        userId: user!.id,
        username: 'jrfx99',
        platformUserId: '42',
        verifiedAt: new Date(),
        lastSyncedAt: new Date(),
        ...over,
      })
      .returning({ id: schema.chessAccounts.id });

    return account!.id;
  }

  async function accountRow(id: string) {
    return db.query.chessAccounts.findFirst({ where: eq(schema.chessAccounts.id, id) });
  }

  beforeEach(async () => {
    await db.delete(schema.jobs);
    await db.delete(schema.chessAccounts);
    await db.delete(schema.users);
  });

  afterAll(async () => {
    await db.delete(schema.users);
  });

  it('syncs when the player id still matches', async () => {
    const id = await makeAccount();
    const result = await runIngest({ db, client: clientFor(42) }, { chessAccountId: id });

    expect(result.gamesAdded).toBe(0);
    expect((await accountRow(id))?.verifiedAt).toBeInstanceOf(Date);
  });

  it('revokes the link when the username now belongs to a different account', async () => {
    const id = await makeAccount();

    await expect(
      runIngest({ db, client: clientFor(99) }, { chessAccountId: id }),
    ).rejects.toThrow(/different Chess\.com account/i);

    expect((await accountRow(id))?.verifiedAt).toBeNull();
  });

  it('ingests nothing at all when the link is revoked', async () => {
    const id = await makeAccount();
    await runIngest({ db, client: clientFor(99) }, { chessAccountId: id }).catch(() => undefined);

    const games = await db.select().from(schema.games);
    expect(games).toHaveLength(0);
  });

  it('expires a link that has not synced for over a year', async () => {
    const id = await makeAccount({
      verifiedAt: new Date(Date.now() - 2 * YEAR_MS),
      lastSyncedAt: new Date(Date.now() - 2 * YEAR_MS),
    });

    await expect(
      runIngest({ db, client: clientFor(42) }, { chessAccountId: id }),
    ).rejects.toThrow(/over a year/i);

    expect((await accountRow(id))?.verifiedAt).toBeNull();
  });

  it('backfills the player id for a link proved before the check existed', async () => {
    const id = await makeAccount({ platformUserId: null });
    await runIngest({ db, client: clientFor(42) }, { chessAccountId: id });

    expect((await accountRow(id))?.platformUserId).toBe('42');
  });

  it('does not revoke a link that simply predates the check', async () => {
    const id = await makeAccount({ platformUserId: null });
    await runIngest({ db, client: clientFor(42) }, { chessAccountId: id });

    expect((await accountRow(id))?.verifiedAt).toBeInstanceOf(Date);
  });

  it('refuses to sync an account that was never verified', async () => {
    const id = await makeAccount({ verifiedAt: null });

    await expect(
      runIngest({ db, client: clientFor(42) }, { chessAccountId: id }),
    ).rejects.toThrow(/not been verified/i);
  });

  it('skips an unparseable game instead of losing the whole archive', async () => {
    const id = await makeAccount();
    const good = {
      url: 'https://www.chess.com/game/live/1',
      pgn: ['[White "jrfx99"]', '[Black "opp"]', '[ECO "C50"]', '', '1. e4 e5 1-0', ''].join('\n'),
      time_control: '180',
      time_class: 'blitz',
      rated: true,
      rules: 'chess',
      end_time: 1_785_000_000,
      white: { username: 'jrfx99', rating: 1200, result: 'win' },
      black: { username: 'opp', rating: 1200, result: 'resigned' },
    };
    // Same shape, but the movetext cannot be replayed from the initial position.
    const bad = {
      ...good,
      url: 'https://www.chess.com/game/live/2',
      pgn: ['[White "jrfx99"]', '[Black "opp"]', '', '1. Qh8 Qa1 1-0', ''].join('\n'),
    };

    const client = new ChessComClient({
      contact: 'test@example.com',
      minIntervalMs: 0,
      sleep: () => Promise.resolve(),
      fetchImpl: (async (url: string) => {
        const body = url.endsWith('/archives')
          ? { archives: ['https://api.chess.com/pub/player/jrfx99/games/2026/08'] }
          : url.includes('/games/2026/08')
            ? { games: [bad, good] }
            : { username: 'jrfx99', player_id: 42 };
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }) as unknown as typeof fetch,
    });

    const result = await runIngest({ db, client }, { chessAccountId: id });

    expect(result.gamesSkipped).toBe(1);
    expect(result.gamesAdded).toBe(1);

    // The good game that came *after* the bad one still landed.
    const games = await db.select().from(schema.games);
    expect(games).toHaveLength(1);
    expect(games[0]!.url).toBe('https://www.chess.com/game/live/1');
  });

  it('fails loudly when the username has vanished from Chess.com', async () => {
    const id = await makeAccount();

    await expect(
      runIngest({ db, client: clientFor(null) }, { chessAccountId: id }),
    ).rejects.toThrow(/no longer knows/i);
  });
});
