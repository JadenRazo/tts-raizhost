CREATE TABLE "invite_codes" (
	"code" text PRIMARY KEY NOT NULL,
	"issued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"issued_by" text,
	"consumed_at" timestamp with time zone,
	"consumed_by_email" text,
	"consumed_by_user_id" uuid,
	"notes" text
);
--> statement-breakpoint
CREATE TABLE "user_tts_quota" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"chars_used_today" integer DEFAULT 0 NOT NULL,
	"daily_limit" integer DEFAULT 200000 NOT NULL,
	"last_reset_at" timestamp with time zone DEFAULT now() NOT NULL,
	"total_chars_lifetime" bigint DEFAULT 0 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "user_settings" ALTER COLUMN "voice_id" SET DEFAULT 'af_heart';--> statement-breakpoint
ALTER TABLE "invite_codes" ADD CONSTRAINT "invite_codes_consumed_by_user_id_users_id_fk" FOREIGN KEY ("consumed_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_tts_quota" ADD CONSTRAINT "user_tts_quota_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "invite_codes_unconsumed_idx" ON "invite_codes" USING btree ("consumed_at") WHERE "invite_codes"."consumed_at" is null;