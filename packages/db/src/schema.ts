import { relations, sql } from 'drizzle-orm';
import {
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  real,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  vector,
} from 'drizzle-orm/pg-core';

/**
 * The single schema owner for ChessEdu. Nothing outside this package defines DDL or table
 * types. See the data model diagram in docs/architecture.md.
 */

/* ------------------------------------------------------------------ *
 * Auth.js — shape required by @auth/drizzle-adapter. Do not rename.
 * ------------------------------------------------------------------ */

export const users = pgTable('user', {
  id: text('id')
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  name: text('name'),
  email: text('email').unique(),
  emailVerified: timestamp('emailVerified', { mode: 'date', withTimezone: true }),
  image: text('image'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const accounts = pgTable(
  'account',
  {
    userId: text('userId')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    type: text('type').$type<'oauth' | 'oidc' | 'email' | 'webauthn'>().notNull(),
    provider: text('provider').notNull(),
    providerAccountId: text('providerAccountId').notNull(),
    refresh_token: text('refresh_token'),
    access_token: text('access_token'),
    expires_at: integer('expires_at'),
    token_type: text('token_type'),
    scope: text('scope'),
    id_token: text('id_token'),
    session_state: text('session_state'),
  },
  (table) => [primaryKey({ columns: [table.provider, table.providerAccountId] })],
);

/**
 * Database-backed sessions rather than JWTs, so a session can be revoked server-side.
 * See the security posture in docs/architecture.md.
 */
export const sessions = pgTable('session', {
  sessionToken: text('sessionToken').primaryKey(),
  userId: text('userId')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  expires: timestamp('expires', { mode: 'date', withTimezone: true }).notNull(),
});

export const verificationTokens = pgTable(
  'verificationToken',
  {
    identifier: text('identifier').notNull(),
    token: text('token').notNull(),
    expires: timestamp('expires', { mode: 'date', withTimezone: true }).notNull(),
  },
  (table) => [primaryKey({ columns: [table.identifier, table.token] })],
);

/* ------------------------------------------------------------------ *
 * Linked chess platform accounts
 * ------------------------------------------------------------------ */

export const platformEnum = pgEnum('platform', ['chesscom', 'lichess']);
export const colorEnum = pgEnum('color', ['w', 'b']);
export const gameResultEnum = pgEnum('game_result', ['win', 'loss', 'draw']);
export const phaseEnum = pgEnum('phase', ['opening', 'middlegame', 'endgame']);
export const classificationEnum = pgEnum('classification', [
  'blunder',
  'mistake',
  'inaccuracy',
  'good',
]);

/**
 * A chess platform account proved to belong to a user. `verifiedAt` is only set once the
 * nonce challenge below has succeeded — see docs/chess-com-linking.md.
 */
export const chessAccounts = pgTable(
  'chess_account',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    platform: platformEnum('platform').notNull().default('chesscom'),
    username: text('username').notNull(),
    /** Stable platform id, so a rename can be detected without losing the link. */
    platformUserId: text('platform_user_id'),
    verifiedAt: timestamp('verified_at', { withTimezone: true }),
    lastSyncedAt: timestamp('last_synced_at', { withTimezone: true }),
    profile: jsonb('profile'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('chess_account_platform_username_idx').on(table.platform, table.username),
    index('chess_account_user_idx').on(table.userId),
  ],
);

/** A pending ownership proof. Single use, short lived, attempt limited. */
export const linkChallenges = pgTable(
  'link_challenge',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    platform: platformEnum('platform').notNull().default('chesscom'),
    username: text('username').notNull(),
    nonce: text('nonce').notNull(),
    attempts: integer('attempts').notNull().default(0),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('link_challenge_user_idx').on(table.userId, table.createdAt)],
);

/* ------------------------------------------------------------------ *
 * Games
 * ------------------------------------------------------------------ */

/** One monthly archive, cached so a re-sync of an unchanged month costs a single 304. */
export const archives = pgTable(
  'archive',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    chessAccountId: uuid('chess_account_id')
      .notNull()
      .references(() => chessAccounts.id, { onDelete: 'cascade' }),
    url: text('url').notNull(),
    year: smallint('year').notNull(),
    month: smallint('month').notNull(),
    etag: text('etag'),
    lastModified: text('last_modified'),
    gameCount: integer('game_count').notNull().default(0),
    fetchedAt: timestamp('fetched_at', { withTimezone: true }),
  },
  (table) => [uniqueIndex('archive_account_period_idx').on(table.chessAccountId, table.url)],
);

export const games = pgTable(
  'game',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    chessAccountId: uuid('chess_account_id')
      .notNull()
      .references(() => chessAccounts.id, { onDelete: 'cascade' }),
    platform: platformEnum('platform').notNull().default('chesscom'),
    platformGameId: text('platform_game_id').notNull(),
    url: text('url').notNull(),
    playedAt: timestamp('played_at', { withTimezone: true }).notNull(),
    timeControl: text('time_control').notNull(),
    timeClass: text('time_class').notNull(),
    rated: boolean('rated').notNull().default(true),
    rules: text('rules').notNull().default('chess'),
    eco: text('eco'),
    ecoUrl: text('eco_url'),
    whiteUsername: text('white_username').notNull(),
    blackUsername: text('black_username').notNull(),
    userColor: colorEnum('user_color').notNull(),
    userResult: gameResultEnum('user_result').notNull(),
    userRating: integer('user_rating'),
    opponentUsername: text('opponent_username').notNull(),
    opponentRating: integer('opponent_rating'),
    moveCount: integer('move_count').notNull().default(0),
    finalFen: text('final_fen'),
    pgn: text('pgn').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('game_platform_id_idx').on(table.platform, table.platformGameId),
    index('game_account_played_idx').on(table.chessAccountId, table.playedAt),
    index('game_eco_idx').on(table.chessAccountId, table.eco),
  ],
);

export const moves = pgTable(
  'move',
  {
    gameId: uuid('game_id')
      .notNull()
      .references(() => games.id, { onDelete: 'cascade' }),
    ply: integer('ply').notNull(),
    color: colorEnum('color').notNull(),
    san: text('san').notNull(),
    uci: text('uci').notNull(),
    fenBefore: text('fen_before').notNull(),
    /** Clock remaining after the move. Drives the time-trouble correlation. */
    clockMs: integer('clock_ms'),
  },
  (table) => [primaryKey({ columns: [table.gameId, table.ply] })],
);

/* ------------------------------------------------------------------ *
 * Analysis
 * ------------------------------------------------------------------ */

/** Per-ply engine output. Every number the coach cites comes from this table. */
export const moveAnalysis = pgTable(
  'move_analysis',
  {
    gameId: uuid('game_id')
      .notNull()
      .references(() => games.id, { onDelete: 'cascade' }),
    ply: integer('ply').notNull(),
    /** Evaluation after the move, from White's perspective. */
    evalCp: integer('eval_cp'),
    mateIn: smallint('mate_in'),
    bestMoveUci: text('best_move_uci'),
    /** Principal variation from the position before the move. */
    pv: text('pv').array(),
    centipawnLoss: integer('centipawn_loss').notNull(),
    winPercentLoss: real('win_percent_loss').notNull(),
    classification: classificationEnum('classification').notNull(),
    phase: phaseEnum('phase').notNull(),
    isCritical: boolean('is_critical').notNull().default(false),
  },
  (table) => [
    primaryKey({ columns: [table.gameId, table.ply] }),
    index('move_analysis_classification_idx').on(table.classification),
  ],
);

export const gameAnalysis = pgTable('game_analysis', {
  gameId: uuid('game_id')
    .primaryKey()
    .references(() => games.id, { onDelete: 'cascade' }),
  engine: text('engine').notNull(),
  depth: smallint('depth').notNull(),
  accuracyWhite: real('accuracy_white'),
  accuracyBlack: real('accuracy_black'),
  acplWhite: integer('acpl_white'),
  acplBlack: integer('acpl_black'),
  /** Accuracy and centipawn loss broken out per phase, for the strength model. */
  phaseBreakdown: jsonb('phase_breakdown'),
  blunderCount: smallint('blunder_count').notNull().default(0),
  mistakeCount: smallint('mistake_count').notNull().default(0),
  inaccuracyCount: smallint('inaccuracy_count').notNull().default(0),
  completedAt: timestamp('completed_at', { withTimezone: true }).notNull().defaultNow(),
});

/* ------------------------------------------------------------------ *
 * Education
 * ------------------------------------------------------------------ */

/** A puzzle generated from one of the user's own mistakes, on an SM-2 review schedule. */
export const puzzles = pgTable(
  'puzzle',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    gameId: uuid('game_id').references(() => games.id, { onDelete: 'cascade' }),
    ply: integer('ply'),
    fen: text('fen').notNull(),
    solutionUci: text('solution_uci').array().notNull(),
    playedUci: text('played_uci'),
    themes: text('themes').array().notNull().default(sql`ARRAY[]::text[]`),
    phase: phaseEnum('phase'),
    dueAt: timestamp('due_at', { withTimezone: true }).notNull().defaultNow(),
    intervalDays: real('interval_days').notNull().default(0),
    ease: real('ease').notNull().default(2.5),
    repetitions: smallint('repetitions').notNull().default(0),
    lapses: smallint('lapses').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('puzzle_due_idx').on(table.userId, table.dueAt),
    uniqueIndex('puzzle_position_idx').on(table.gameId, table.ply),
  ],
);

/** Reference literature, so coaching cites a real source instead of improvising. */
export const corpusDocs = pgTable('corpus_doc', {
  id: uuid('id').primaryKey().defaultRandom(),
  title: text('title').notNull(),
  author: text('author'),
  year: smallint('year'),
  /** Recorded because anything beyond public domain needs a licence decision first. */
  license: text('license').notNull(),
  sourceUrl: text('source_url'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const corpusChunks = pgTable(
  'corpus_chunk',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    docId: uuid('doc_id')
      .notNull()
      .references(() => corpusDocs.id, { onDelete: 'cascade' }),
    ordinal: integer('ordinal').notNull(),
    content: text('content').notNull(),
    /** Citable location within the source, e.g. "ch. 4, p. 91". */
    locator: text('locator'),
    embedding: vector('embedding', { dimensions: 1536 }),
  },
  (table) => [
    uniqueIndex('corpus_chunk_ordinal_idx').on(table.docId, table.ordinal),
    index('corpus_chunk_embedding_idx').using(
      'hnsw',
      table.embedding.op('vector_cosine_ops'),
    ),
  ],
);

/* ------------------------------------------------------------------ *
 * Job queue — Postgres SKIP LOCKED, no Redis. See ADR 0001.
 * ------------------------------------------------------------------ */

export const jobKindEnum = pgEnum('job_kind', ['ingest', 'analyze', 'embed', 'puzzle_gen']);
export const jobStateEnum = pgEnum('job_state', ['pending', 'running', 'done', 'failed']);

export const jobs = pgTable(
  'job',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    kind: jobKindEnum('kind').notNull(),
    payload: jsonb('payload').notNull(),
    state: jobStateEnum('state').notNull().default('pending'),
    /** Higher runs first. Interactive requests outrank a history backfill. */
    priority: smallint('priority').notNull().default(0),
    attempts: smallint('attempts').notNull().default(0),
    maxAttempts: smallint('max_attempts').notNull().default(3),
    runAfter: timestamp('run_after', { withTimezone: true }).notNull().defaultNow(),
    lockedAt: timestamp('locked_at', { withTimezone: true }),
    lockedBy: text('locked_by'),
    lastError: text('last_error'),
    /** Set to make enqueueing idempotent, e.g. `analyze:<gameId>`. */
    dedupeKey: text('dedupe_key'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('job_claim_idx').on(table.state, table.runAfter, table.priority),
    uniqueIndex('job_dedupe_idx').on(table.dedupeKey),
  ],
);

/* ------------------------------------------------------------------ *
 * Relations
 * ------------------------------------------------------------------ */

export const usersRelations = relations(users, ({ many }) => ({
  chessAccounts: many(chessAccounts),
  puzzles: many(puzzles),
}));

export const chessAccountsRelations = relations(chessAccounts, ({ one, many }) => ({
  user: one(users, { fields: [chessAccounts.userId], references: [users.id] }),
  games: many(games),
  archives: many(archives),
}));

export const gamesRelations = relations(games, ({ one, many }) => ({
  chessAccount: one(chessAccounts, {
    fields: [games.chessAccountId],
    references: [chessAccounts.id],
  }),
  moves: many(moves),
  moveAnalysis: many(moveAnalysis),
  analysis: one(gameAnalysis, { fields: [games.id], references: [gameAnalysis.gameId] }),
}));

export const corpusDocsRelations = relations(corpusDocs, ({ many }) => ({
  chunks: many(corpusChunks),
}));

export type User = typeof users.$inferSelect;
export type ChessAccount = typeof chessAccounts.$inferSelect;
export type LinkChallenge = typeof linkChallenges.$inferSelect;
export type Game = typeof games.$inferSelect;
export type NewGame = typeof games.$inferInsert;
export type Move = typeof moves.$inferSelect;
export type Job = typeof jobs.$inferSelect;
export type Puzzle = typeof puzzles.$inferSelect;
