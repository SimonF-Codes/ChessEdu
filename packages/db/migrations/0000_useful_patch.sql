CREATE EXTENSION IF NOT EXISTS vector;--> statement-breakpoint
CREATE TYPE "public"."classification" AS ENUM('blunder', 'mistake', 'inaccuracy', 'good');--> statement-breakpoint
CREATE TYPE "public"."color" AS ENUM('w', 'b');--> statement-breakpoint
CREATE TYPE "public"."game_result" AS ENUM('win', 'loss', 'draw');--> statement-breakpoint
CREATE TYPE "public"."job_kind" AS ENUM('ingest', 'analyze', 'embed', 'puzzle_gen');--> statement-breakpoint
CREATE TYPE "public"."job_state" AS ENUM('pending', 'running', 'done', 'failed');--> statement-breakpoint
CREATE TYPE "public"."phase" AS ENUM('opening', 'middlegame', 'endgame');--> statement-breakpoint
CREATE TYPE "public"."platform" AS ENUM('chesscom', 'lichess');--> statement-breakpoint
CREATE TABLE "account" (
	"userId" text NOT NULL,
	"type" text NOT NULL,
	"provider" text NOT NULL,
	"providerAccountId" text NOT NULL,
	"refresh_token" text,
	"access_token" text,
	"expires_at" integer,
	"token_type" text,
	"scope" text,
	"id_token" text,
	"session_state" text,
	CONSTRAINT "account_provider_providerAccountId_pk" PRIMARY KEY("provider","providerAccountId")
);
--> statement-breakpoint
CREATE TABLE "archive" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"chess_account_id" uuid NOT NULL,
	"url" text NOT NULL,
	"year" smallint NOT NULL,
	"month" smallint NOT NULL,
	"etag" text,
	"last_modified" text,
	"game_count" integer DEFAULT 0 NOT NULL,
	"fetched_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "chess_account" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"platform" "platform" DEFAULT 'chesscom' NOT NULL,
	"username" text NOT NULL,
	"platform_user_id" text,
	"verified_at" timestamp with time zone,
	"last_synced_at" timestamp with time zone,
	"profile" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "corpus_chunk" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"doc_id" uuid NOT NULL,
	"ordinal" integer NOT NULL,
	"content" text NOT NULL,
	"locator" text,
	"embedding" vector(1536)
);
--> statement-breakpoint
CREATE TABLE "corpus_doc" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"title" text NOT NULL,
	"author" text,
	"year" smallint,
	"license" text NOT NULL,
	"source_url" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "game_analysis" (
	"game_id" uuid PRIMARY KEY NOT NULL,
	"engine" text NOT NULL,
	"depth" smallint NOT NULL,
	"accuracy_white" real,
	"accuracy_black" real,
	"acpl_white" integer,
	"acpl_black" integer,
	"phase_breakdown" jsonb,
	"blunder_count" smallint DEFAULT 0 NOT NULL,
	"mistake_count" smallint DEFAULT 0 NOT NULL,
	"inaccuracy_count" smallint DEFAULT 0 NOT NULL,
	"completed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "game" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"chess_account_id" uuid NOT NULL,
	"platform" "platform" DEFAULT 'chesscom' NOT NULL,
	"platform_game_id" text NOT NULL,
	"url" text NOT NULL,
	"played_at" timestamp with time zone NOT NULL,
	"time_control" text NOT NULL,
	"time_class" text NOT NULL,
	"rated" boolean DEFAULT true NOT NULL,
	"rules" text DEFAULT 'chess' NOT NULL,
	"eco" text,
	"eco_url" text,
	"white_username" text NOT NULL,
	"black_username" text NOT NULL,
	"user_color" "color" NOT NULL,
	"user_result" "game_result" NOT NULL,
	"user_rating" integer,
	"opponent_username" text NOT NULL,
	"opponent_rating" integer,
	"move_count" integer DEFAULT 0 NOT NULL,
	"final_fen" text,
	"pgn" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "job" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" "job_kind" NOT NULL,
	"payload" jsonb NOT NULL,
	"state" "job_state" DEFAULT 'pending' NOT NULL,
	"priority" smallint DEFAULT 0 NOT NULL,
	"attempts" smallint DEFAULT 0 NOT NULL,
	"max_attempts" smallint DEFAULT 3 NOT NULL,
	"run_after" timestamp with time zone DEFAULT now() NOT NULL,
	"locked_at" timestamp with time zone,
	"locked_by" text,
	"last_error" text,
	"dedupe_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "link_challenge" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"platform" "platform" DEFAULT 'chesscom' NOT NULL,
	"username" text NOT NULL,
	"nonce" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "move_analysis" (
	"game_id" uuid NOT NULL,
	"ply" integer NOT NULL,
	"eval_cp" integer,
	"mate_in" smallint,
	"best_move_uci" text,
	"pv" text[],
	"centipawn_loss" integer NOT NULL,
	"win_percent_loss" real NOT NULL,
	"classification" "classification" NOT NULL,
	"phase" "phase" NOT NULL,
	"is_critical" boolean DEFAULT false NOT NULL,
	CONSTRAINT "move_analysis_game_id_ply_pk" PRIMARY KEY("game_id","ply")
);
--> statement-breakpoint
CREATE TABLE "move" (
	"game_id" uuid NOT NULL,
	"ply" integer NOT NULL,
	"color" "color" NOT NULL,
	"san" text NOT NULL,
	"uci" text NOT NULL,
	"fen_before" text NOT NULL,
	"clock_ms" integer,
	CONSTRAINT "move_game_id_ply_pk" PRIMARY KEY("game_id","ply")
);
--> statement-breakpoint
CREATE TABLE "puzzle" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"game_id" uuid,
	"ply" integer,
	"fen" text NOT NULL,
	"solution_uci" text[] NOT NULL,
	"played_uci" text,
	"themes" text[] DEFAULT ARRAY[]::text[] NOT NULL,
	"phase" "phase",
	"due_at" timestamp with time zone DEFAULT now() NOT NULL,
	"interval_days" real DEFAULT 0 NOT NULL,
	"ease" real DEFAULT 2.5 NOT NULL,
	"repetitions" smallint DEFAULT 0 NOT NULL,
	"lapses" smallint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "session" (
	"sessionToken" text PRIMARY KEY NOT NULL,
	"userId" text NOT NULL,
	"expires" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text,
	"email" text,
	"emailVerified" timestamp with time zone,
	"image" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "verificationToken" (
	"identifier" text NOT NULL,
	"token" text NOT NULL,
	"expires" timestamp with time zone NOT NULL,
	CONSTRAINT "verificationToken_identifier_token_pk" PRIMARY KEY("identifier","token")
);
--> statement-breakpoint
ALTER TABLE "account" ADD CONSTRAINT "account_userId_user_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "archive" ADD CONSTRAINT "archive_chess_account_id_chess_account_id_fk" FOREIGN KEY ("chess_account_id") REFERENCES "public"."chess_account"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chess_account" ADD CONSTRAINT "chess_account_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "corpus_chunk" ADD CONSTRAINT "corpus_chunk_doc_id_corpus_doc_id_fk" FOREIGN KEY ("doc_id") REFERENCES "public"."corpus_doc"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "game_analysis" ADD CONSTRAINT "game_analysis_game_id_game_id_fk" FOREIGN KEY ("game_id") REFERENCES "public"."game"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "game" ADD CONSTRAINT "game_chess_account_id_chess_account_id_fk" FOREIGN KEY ("chess_account_id") REFERENCES "public"."chess_account"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "link_challenge" ADD CONSTRAINT "link_challenge_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "move_analysis" ADD CONSTRAINT "move_analysis_game_id_game_id_fk" FOREIGN KEY ("game_id") REFERENCES "public"."game"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "move" ADD CONSTRAINT "move_game_id_game_id_fk" FOREIGN KEY ("game_id") REFERENCES "public"."game"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "puzzle" ADD CONSTRAINT "puzzle_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "puzzle" ADD CONSTRAINT "puzzle_game_id_game_id_fk" FOREIGN KEY ("game_id") REFERENCES "public"."game"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_userId_user_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "archive_account_period_idx" ON "archive" USING btree ("chess_account_id","url");--> statement-breakpoint
CREATE UNIQUE INDEX "chess_account_platform_username_idx" ON "chess_account" USING btree ("platform","username");--> statement-breakpoint
CREATE INDEX "chess_account_user_idx" ON "chess_account" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "corpus_chunk_ordinal_idx" ON "corpus_chunk" USING btree ("doc_id","ordinal");--> statement-breakpoint
CREATE INDEX "corpus_chunk_embedding_idx" ON "corpus_chunk" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "game_platform_id_idx" ON "game" USING btree ("platform","platform_game_id");--> statement-breakpoint
CREATE INDEX "game_account_played_idx" ON "game" USING btree ("chess_account_id","played_at");--> statement-breakpoint
CREATE INDEX "game_eco_idx" ON "game" USING btree ("chess_account_id","eco");--> statement-breakpoint
CREATE INDEX "job_claim_idx" ON "job" USING btree ("state","run_after","priority");--> statement-breakpoint
CREATE UNIQUE INDEX "job_dedupe_idx" ON "job" USING btree ("dedupe_key");--> statement-breakpoint
CREATE INDEX "link_challenge_user_idx" ON "link_challenge" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "move_analysis_classification_idx" ON "move_analysis" USING btree ("classification");--> statement-breakpoint
CREATE INDEX "puzzle_due_idx" ON "puzzle" USING btree ("user_id","due_at");--> statement-breakpoint
CREATE UNIQUE INDEX "puzzle_position_idx" ON "puzzle" USING btree ("game_id","ply");