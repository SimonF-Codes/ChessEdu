DROP INDEX "job_dedupe_idx";--> statement-breakpoint
CREATE UNIQUE INDEX "job_dedupe_idx" ON "job" USING btree ("dedupe_key") WHERE "job"."state" in ('pending', 'running');