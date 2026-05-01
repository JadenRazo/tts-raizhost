CREATE TABLE "bookmarks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"book_id" uuid NOT NULL,
	"sentence_idx" integer NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bookmarks_sentence_idx_chk" CHECK ("bookmarks"."sentence_idx" >= 0)
);
--> statement-breakpoint
ALTER TABLE "user_settings" ADD COLUMN "next_track_action" text DEFAULT 'next_page' NOT NULL;--> statement-breakpoint
ALTER TABLE "user_settings" ADD COLUMN "prev_track_action" text DEFAULT 'prev_page' NOT NULL;--> statement-breakpoint
ALTER TABLE "user_settings" ADD COLUMN "seek_forward_action" text DEFAULT 'seek_forward' NOT NULL;--> statement-breakpoint
ALTER TABLE "user_settings" ADD COLUMN "seek_backward_action" text DEFAULT 'seek_back' NOT NULL;--> statement-breakpoint
ALTER TABLE "user_settings" ADD COLUMN "seek_step_seconds" integer DEFAULT 15 NOT NULL;--> statement-breakpoint
ALTER TABLE "user_settings" ADD COLUMN "smart_rewind_seconds" integer DEFAULT 5 NOT NULL;--> statement-breakpoint
ALTER TABLE "user_settings" ADD COLUMN "sleep_timer_default_minutes" integer DEFAULT 30 NOT NULL;--> statement-breakpoint
ALTER TABLE "bookmarks" ADD CONSTRAINT "bookmarks_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bookmarks" ADD CONSTRAINT "bookmarks_book_id_books_id_fk" FOREIGN KEY ("book_id") REFERENCES "public"."books"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "bookmarks_user_book_idx" ON "bookmarks" USING btree ("user_id","book_id","sentence_idx");--> statement-breakpoint
ALTER TABLE "user_settings" ADD CONSTRAINT "user_settings_next_track_action_chk" CHECK ("user_settings"."next_track_action" in ('next_sentence','next_page','next_chapter','seek_forward','restart_sentence'));--> statement-breakpoint
ALTER TABLE "user_settings" ADD CONSTRAINT "user_settings_prev_track_action_chk" CHECK ("user_settings"."prev_track_action" in ('prev_sentence','prev_page','prev_chapter','seek_back','restart_sentence','restart_book'));--> statement-breakpoint
ALTER TABLE "user_settings" ADD CONSTRAINT "user_settings_seek_forward_action_chk" CHECK ("user_settings"."seek_forward_action" in ('seek_forward','next_sentence','next_page','next_chapter'));--> statement-breakpoint
ALTER TABLE "user_settings" ADD CONSTRAINT "user_settings_seek_backward_action_chk" CHECK ("user_settings"."seek_backward_action" in ('seek_back','prev_sentence','prev_page','prev_chapter','restart_sentence'));--> statement-breakpoint
ALTER TABLE "user_settings" ADD CONSTRAINT "user_settings_seek_step_seconds_chk" CHECK ("user_settings"."seek_step_seconds" between 5 and 120);--> statement-breakpoint
ALTER TABLE "user_settings" ADD CONSTRAINT "user_settings_smart_rewind_seconds_chk" CHECK ("user_settings"."smart_rewind_seconds" between 0 and 60);--> statement-breakpoint
ALTER TABLE "user_settings" ADD CONSTRAINT "user_settings_sleep_timer_default_minutes_chk" CHECK ("user_settings"."sleep_timer_default_minutes" between 5 and 120);