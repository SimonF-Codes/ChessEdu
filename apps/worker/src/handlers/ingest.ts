import { and, eq } from 'drizzle-orm';

import { normalizeGame, reverificationMessage, reverificationNeeded } from '@chessedu/chess';
import type { ChessComClient } from '@chessedu/chesscom';
import { type Database, enqueue, schema } from '@chessedu/db';

/**
 * Pull a linked account's game history.
 *
 * Serial and conditional throughout: the client enforces one request at a time, and stored
 * validators turn a re-sync of a settled month into a single 304. See docs/chess-com-linking.md.
 */

export interface IngestPayload {
  chessAccountId: string;
}

/** `.../games/2026/08` -> { year: 2026, month: 8 } */
export function parseArchiveUrl(url: string): { year: number; month: number } | null {
  const match = /\/games\/(\d{4})\/(\d{2})$/.exec(url);
  if (!match) return null;
  return { year: Number(match[1]), month: Number(match[2]) };
}

/**
 * Whether a month can be skipped without even a conditional request. Past months do not
 * change once seen; the current month always might.
 */
export function isSettledMonth(
  archive: { year: number; month: number },
  now: Date,
): boolean {
  const currentYear = now.getUTCFullYear();
  const currentMonth = now.getUTCMonth() + 1;
  return archive.year < currentYear || (archive.year === currentYear && archive.month < currentMonth);
}

export async function runIngest(
  context: { db: Database; client: ChessComClient; now?: () => Date },
  payload: IngestPayload,
): Promise<{ archivesFetched: number; gamesAdded: number }> {
  const { db, client } = context;
  const now = context.now ?? (() => new Date());

  const account = await db.query.chessAccounts.findFirst({
    where: eq(schema.chessAccounts.id, payload.chessAccountId),
  });
  if (!account) throw new Error(`no chess account ${payload.chessAccountId}`);

  // The proof is checked before a single archive is fetched. Ingesting under a link whose
  // username now belongs to someone else would attribute a stranger's games to this user.
  // See "Re-verification" in docs/chess-com-linking.md.
  const profile = await client.getProfile(account.username);
  if (!profile) throw new Error(`chess.com no longer knows ${account.username}`);

  const reason = reverificationNeeded({
    storedPlatformUserId: account.platformUserId,
    currentPlatformUserId: String(profile.player_id),
    verifiedAt: account.verifiedAt,
    lastSyncedAt: account.lastSyncedAt,
    now: now(),
  });

  if (reason) {
    // Clearing verifiedAt is what actually stops further syncing and prompts the user; the
    // games already stored stay, since they were ingested under a proof that held at the time.
    await db
      .update(schema.chessAccounts)
      .set({ verifiedAt: null })
      .where(eq(schema.chessAccounts.id, account.id));
    throw new Error(`${account.username}: ${reverificationMessage(reason)}`);
  }

  // Backfill the id for links proved before this check existed, so it works from now on.
  if (account.platformUserId === null) {
    await db
      .update(schema.chessAccounts)
      .set({ platformUserId: String(profile.player_id) })
      .where(eq(schema.chessAccounts.id, account.id));
  }

  const urls = await client.getArchiveUrls(account.username);
  let archivesFetched = 0;
  let gamesAdded = 0;

  for (const url of urls) {
    const period = parseArchiveUrl(url);
    if (!period) continue;

    const existing = await db.query.archives.findFirst({
      where: and(
        eq(schema.archives.chessAccountId, account.id),
        eq(schema.archives.url, url),
      ),
    });

    // A month we have already read in full, that can no longer change, costs nothing.
    if (existing?.fetchedAt && isSettledMonth(period, now())) continue;

    const response = await client.getArchive(url, {
      etag: existing?.etag,
      lastModified: existing?.lastModified,
    });
    archivesFetched += 1;

    if (response.status === 'unchanged') continue;

    for (const raw of response.games) {
      // Variants share the archive with standard chess; the analytics only cover chess.
      if (raw.rules !== 'chess') continue;

      const game = normalizeGame(raw, account.username);
      const [inserted] = await db
        .insert(schema.games)
        .values({
          chessAccountId: account.id,
          platform: 'chesscom',
          platformGameId: game.platformGameId,
          url: game.url,
          playedAt: game.playedAt,
          timeControl: game.timeControl,
          timeClass: game.timeClass,
          rated: game.rated,
          rules: game.rules,
          eco: game.eco,
          ecoUrl: game.ecoUrl,
          whiteUsername: game.whiteUsername,
          blackUsername: game.blackUsername,
          userColor: game.userColor,
          userResult: game.userResult,
          userRating: game.userRating,
          opponentUsername: game.opponentUsername,
          opponentRating: game.opponentRating,
          moveCount: game.moveCount,
          finalFen: game.finalFen,
          pgn: game.pgn,
        })
        // Already seen: a re-sync of the current month re-reads games we have.
        .onConflictDoNothing({
          target: [schema.games.platform, schema.games.platformGameId],
        })
        .returning({ id: schema.games.id });

      if (!inserted) continue;
      gamesAdded += 1;

      if (game.moves.length > 0) {
        await db.insert(schema.moves).values(
          game.moves.map((move) => ({
            gameId: inserted.id,
            ply: move.ply,
            color: move.color,
            san: move.san,
            uci: move.uci,
            fenBefore: move.fenBefore,
            clockMs: move.clockMs,
          })),
        );
      }

      await enqueue(db, {
        kind: 'analyze',
        payload: { gameId: inserted.id },
        dedupeKey: `analyze:${inserted.id}`,
        // Below anything interactive, and newest games first once the backlog drains.
        priority: 0,
      });
    }

    await db
      .insert(schema.archives)
      .values({
        chessAccountId: account.id,
        url,
        year: period.year,
        month: period.month,
        etag: response.etag,
        lastModified: response.lastModified,
        gameCount: response.games.length,
        fetchedAt: now(),
      })
      .onConflictDoUpdate({
        target: [schema.archives.chessAccountId, schema.archives.url],
        set: {
          etag: response.etag,
          lastModified: response.lastModified,
          gameCount: response.games.length,
          fetchedAt: now(),
        },
      });
  }

  await db
    .update(schema.chessAccounts)
    .set({ lastSyncedAt: now() })
    .where(eq(schema.chessAccounts.id, account.id));

  return { archivesFetched, gamesAdded };
}
