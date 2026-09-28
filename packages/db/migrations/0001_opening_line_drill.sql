CREATE TYPE "public"."ply_result" AS ENUM('first_try', 'second_try', 'revealed', 'abandoned');--> statement-breakpoint
CREATE TABLE "line_attempt" (
	"attempt_id" uuid NOT NULL,
	"ply" smallint NOT NULL,
	"user_id" text NOT NULL,
	"line_id" uuid NOT NULL,
	"result" "ply_result" NOT NULL,
	"wrong_uci" text[] DEFAULT ARRAY[]::text[] NOT NULL,
	"elapsed_ms" integer NOT NULL,
	"attempted_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "line_attempt_attempt_id_ply_pk" PRIMARY KEY("attempt_id","ply")
);
--> statement-breakpoint
CREATE TABLE "line_review" (
	"user_id" text NOT NULL,
	"line_id" uuid NOT NULL,
	"due_at" timestamp with time zone DEFAULT now() NOT NULL,
	"interval_days" real DEFAULT 0 NOT NULL,
	"ease" real DEFAULT 2.5 NOT NULL,
	"repetitions" smallint DEFAULT 0 NOT NULL,
	"lapses" smallint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "line_review_user_id_line_id_pk" PRIMARY KEY("user_id","line_id")
);
--> statement-breakpoint
CREATE TABLE "opening_line" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" text NOT NULL,
	"family" text NOT NULL,
	"eco" text NOT NULL,
	"name" text NOT NULL,
	"learner_color" "color" NOT NULL,
	"plies" jsonb NOT NULL,
	"ply_count" smallint NOT NULL,
	"engine" text NOT NULL,
	"generated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"retired_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "line_attempt" ADD CONSTRAINT "line_attempt_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "line_attempt" ADD CONSTRAINT "line_attempt_line_id_opening_line_id_fk" FOREIGN KEY ("line_id") REFERENCES "public"."opening_line"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "line_review" ADD CONSTRAINT "line_review_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "line_review" ADD CONSTRAINT "line_review_line_id_opening_line_id_fk" FOREIGN KEY ("line_id") REFERENCES "public"."opening_line"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "line_attempt_user_line_idx" ON "line_attempt" USING btree ("user_id","line_id","attempted_at");--> statement-breakpoint
CREATE INDEX "line_review_due_idx" ON "line_review" USING btree ("user_id","due_at");--> statement-breakpoint
CREATE UNIQUE INDEX "opening_line_key_idx" ON "opening_line" USING btree ("key");--> statement-breakpoint
CREATE INDEX "opening_line_family_idx" ON "opening_line" USING btree ("family");