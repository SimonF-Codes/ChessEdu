import { Chess } from 'chess.js';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { familyStandings, positionKey } from '@chessedu/chess';
import { createDatabase, schema } from '@chessedu/db';

import { loadFacedReplies, loadFamilyRecords } from './history';

/**
 * The aggregation that feeds the opening choice (ADR 0009), against real Postgres: per side and
 * family, the games, the points and the opening moves; and per position, what the player's
 * opponents replied. Skipped without TEST_DATABASE_URL. Seeds its own user and accounts and
 * deletes them, cascading to their games, so it never touches anyone else's rows.
 */
const connectionString = process.env.TEST_DATABASE_URL;

const url = (slug: string) => `https://www.chess.com/openings/${slug}`;

describe.skipIf(!connectionString)('the history behind the opening choice', () => {
  const db = createDatabase(connectionString!, { max: 2 });
  let userId: string;
  let accountId: string;
  let otherAccountId: string;
  let seq = 0;

  async function addGame(input: {
    account?: string;
    color: 'w' | 'b';
    result: 'win' | 'draw' | 'loss';
    ecoUrl: string | null;
    eco?: string;
    moves: string;
  }): Promise<void> {
    seq += 1;
    const [game] = await db
      .insert(schema.games)
      .values({
        chessAccountId: input.account ?? accountId,
        platformGameId: `history-test-${crypto.randomUUID()}`,
        url: `https://www.chess.com/game/live/${seq}`,
        playedAt: new Date(Date.UTC(2026, 0, 1, 0, seq)),
        timeControl: '600',
        timeClass: 'rapid',
        eco: input.eco ?? null,
        ecoUrl: input.ecoUrl,
        whiteUsername: 'white',
        blackUsername: 'black',
        userColor: input.color,
        userResult: input.result,
        opponentUsername: 'opponent',
        pgn: input.moves,
      })
      .returning({ id: schema.games.id });

    const board = new Chess();
    const rows = input.moves.split(' ').map((san, index) => {
      const fenBefore = board.fen();
      const move = board.move(san);
      return {
        gameId: game!.id,
        ply: index + 1,
        color: move.color,
        san: move.san,
        uci: `${move.from}${move.to}${move.promotion ?? ''}`,
        fenBefore,
      };
    });
    await db.insert(schema.moves).values(rows);
  }

  beforeAll(async () => {
    const [user] = await db
      .insert(schema.users)
      .values({ email: `history-${crypto.randomUUID()}@example.com`, name: 'History test' })
      .returning({ id: schema.users.id });
    userId = user!.id;
    const accounts = await db
      .insert(schema.chessAccounts)
      .values([
        { userId, username: `history-${crypto.randomUUID()}`, verifiedAt: new Date() },
        { userId, username: `history-other-${crypto.randomUUID()}`, verifiedAt: new Date() },
      ])
      .returning({ id: schema.chessAccounts.id });
    accountId = accounts[0]!.id;
    otherAccountId = accounts[1]!.id;

    // Black, the Scandinavian under three of Chess.com's names: 1 win, 1 draw, 2 losses.
    await addGame({
      color: 'b',
      result: 'win',
      ecoUrl: url('Scandinavian-Defense'),
      eco: 'B01',
      moves: 'e4 d5 exd5 Qxd5 Nc3',
    });
    await addGame({
      color: 'b',
      result: 'draw',
      ecoUrl: url('Scandinavian-Defense-2.e5'),
      eco: 'B01',
      moves: 'e4 d5 e5 c5',
    });
    await addGame({
      color: 'b',
      result: 'loss',
      ecoUrl: url('Scandinavian-Defense-2.e5'),
      eco: 'B01',
      moves: 'e4 d5 e5 c5',
    });
    await addGame({
      color: 'b',
      result: 'loss',
      ecoUrl: url('Scandinavian-Defense-Mieses-Kotrc-Variation-3.Nc3'),
      eco: 'B00',
      moves: 'e4 d5 exd5 Qxd5 Nc3',
    });
    // White, the same family name: kept apart from Black's.
    await addGame({
      color: 'w',
      result: 'win',
      ecoUrl: url('Scandinavian-Defense'),
      eco: 'B01',
      moves: 'e4 d5 exd5',
    });
    // No opening name: left out of the families, but its moves are still faced replies.
    await addGame({ color: 'b', result: 'loss', ecoUrl: null, moves: 'e4 d5 e5 Bf5' });
    // A longer game: only the first moves are handed over.
    await addGame({
      color: 'b',
      result: 'loss',
      ecoUrl: url('Englund-Gambit-2.dxe5'),
      eco: 'A40',
      moves: 'd4 e5 dxe5 Nc6 Nf3 Qe7 Bf4 Qb4+ Bd2 Qxb2',
    });
    // Another account's game: not this player's history.
    await addGame({
      account: otherAccountId,
      color: 'b',
      result: 'loss',
      ecoUrl: url('Scandinavian-Defense'),
      moves: 'e4 d5 Nc3',
    });
  });

  afterAll(async () => {
    await db.delete(schema.users).where(eq(schema.users.id, userId));
  });

  it('totals games and points per side and family, under every name the family goes by', async () => {
    const records = await loadFamilyRecords({ db, chessAccountId: accountId });
    const black = records.find((r) => r.color === 'b' && r.family === 'Scandinavian-Defense')!;
    expect(black).toMatchObject({ games: 4, points: 1.5, eco: 'B01' });
    const white = records.find((r) => r.color === 'w' && r.family === 'Scandinavian-Defense')!;
    expect(white).toMatchObject({ games: 1, points: 1 });
  });

  it('hands over each game’s opening moves, grouped', async () => {
    const records = await loadFamilyRecords({ db, chessAccountId: accountId });
    const black = records.find((r) => r.color === 'b' && r.family === 'Scandinavian-Defense')!;
    expect([...black.openings].sort((a, b) => b.games - a.games)).toEqual([
      { sans: ['e4', 'd5', 'exd5', 'Qxd5', 'Nc3'], games: 2 },
      { sans: ['e4', 'd5', 'e5', 'c5'], games: 2 },
    ]);
    const englund = records.find((r) => r.family === 'Englund-Gambit')!;
    expect(englund.openings).toEqual([
      { sans: ['d4', 'e5', 'dxe5', 'Nc6', 'Nf3', 'Qe7', 'Bf4', 'Qb4+'], games: 1 },
    ]);
  });

  it('leaves out games with no opening name, and other accounts’ games', async () => {
    const records = await loadFamilyRecords({ db, chessAccountId: accountId });
    expect(records.reduce((sum, r) => sum + r.games, 0)).toBe(6);
  });

  it('feeds the ranking: points lost per family', async () => {
    const records = await loadFamilyRecords({ db, chessAccountId: accountId });
    const [first] = familyStandings(records, { minGames: 1 });
    expect(first).toMatchObject({ color: 'b', family: 'Scandinavian-Defense', pointsLost: 0.5 });
  });

  it('counts the opponent’s replies by position, on the learner’s side only', async () => {
    const faced = await loadFacedReplies({ db, chessAccountId: accountId, color: 'b', maxPly: 12 });
    const afterD5 = faced.get(positionKey(fenAfter('e4 d5')))!;
    // 2.e5 three times (the unnamed game included), 2.exd5 twice; the other account's 2.Nc3 not.
    expect(Object.fromEntries(afterD5)).toEqual({ e4e5: 3, e4d5: 2 });
    // The player's own moves are not "faced": no Black move is counted.
    expect(faced.get(positionKey(fenAfter('e4')))).toBeUndefined();
  });

  it('counts only plies up to the depth asked for', async () => {
    const faced = await loadFacedReplies({ db, chessAccountId: accountId, color: 'b', maxPly: 2 });
    expect(faced.size).toBe(1); // only 1.e4 / 1.d4 from the start position
    expect(Object.fromEntries(faced.get(positionKey(new Chess().fen()))!)).toEqual({
      e2e4: 5,
      d2d4: 1,
    });
  });
});

function fenAfter(moves: string): string {
  const board = new Chess();
  for (const san of moves.split(' ')) board.move(san);
  return board.fen();
}
