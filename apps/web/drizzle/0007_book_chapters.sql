CREATE TABLE "book_chapters" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"book_id" uuid NOT NULL,
	"title" text NOT NULL,
	"start_sentence_idx" integer NOT NULL,
	"depth" integer DEFAULT 0 NOT NULL,
	"ord" integer NOT NULL,
	CONSTRAINT "book_chapters_start_sentence_idx_chk" CHECK ("book_chapters"."start_sentence_idx" >= 0),
	CONSTRAINT "book_chapters_depth_chk" CHECK ("book_chapters"."depth" >= 0)
);
--> statement-breakpoint
ALTER TABLE "book_chapters" ADD CONSTRAINT "book_chapters_book_id_books_id_fk" FOREIGN KEY ("book_id") REFERENCES "public"."books"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "book_chapters_book_id_idx" ON "book_chapters" USING btree ("book_id","start_sentence_idx");--> statement-breakpoint
CREATE UNIQUE INDEX "book_chapters_book_id_ord_idx" ON "book_chapters" USING btree ("book_id","ord");