DROP INDEX "invite_codes_unconsumed_idx";--> statement-breakpoint
ALTER TABLE "invite_codes" ADD COLUMN "max_uses" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "invite_codes" ADD COLUMN "use_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
-- Backfill use_count=1 on rows that were already consumed under the
-- single-use scheme so the new constraint and index treat them
-- correctly. New rows pick up the column defaults.
UPDATE "invite_codes" SET "use_count" = 1 WHERE "consumed_at" IS NOT NULL;--> statement-breakpoint
-- Race-safe upper bound. Two concurrent UPDATEs incrementing past
-- max_uses both pass the WHERE clause under READ COMMITTED, but the
-- second one fails the CHECK on commit. Postgres EvalPlanQual on the
-- row lock plus this constraint give us atomic exhaustion semantics
-- without a serializable transaction.
ALTER TABLE "invite_codes" ADD CONSTRAINT "invite_codes_use_count_within_max" CHECK ("use_count" <= "max_uses");--> statement-breakpoint
CREATE INDEX "invite_codes_available_idx" ON "invite_codes" USING btree ("code") WHERE "invite_codes"."use_count" < "invite_codes"."max_uses";