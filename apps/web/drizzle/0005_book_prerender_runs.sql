CREATE TABLE "book_prerender_runs" (
	"book_id" uuid NOT NULL,
	"voice_id" text NOT NULL,
	"speed" real NOT NULL,
	"status" text NOT NULL,
	"prerendered_at" timestamp with time zone,
	"error_text" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "book_prerender_runs_book_id_voice_id_speed_pk" PRIMARY KEY("book_id","voice_id","speed"),
	CONSTRAINT "book_prerender_runs_status_check" CHECK ("book_prerender_runs"."status" in ('queued', 'in_progress', 'complete', 'failed'))
);
--> statement-breakpoint
ALTER TABLE "book_prerender_runs" ADD CONSTRAINT "book_prerender_runs_book_id_books_id_fk" FOREIGN KEY ("book_id") REFERENCES "public"."books"("id") ON DELETE cascade ON UPDATE no action;