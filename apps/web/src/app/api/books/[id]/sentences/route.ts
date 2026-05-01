// POST /api/books/:id/sentences — bulk insert parsed sentences for a book.
//
// Idempotent: the (book_id, idx) primary key + onConflictDoNothing makes it
// safe for the client to retry partial chunks without producing duplicates.
// Bounded: the book row's declared sentenceCount caps the legal idx range,
// so a malicious client can't inflate the table beyond the parsed total.

import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { z } from "zod";

import { getSession } from "@/lib/auth/session";
import { getDb, schema } from "@/lib/db";
import { isUuid } from "@/lib/storage";
import { cleanSentenceText } from "@/lib/text-cleanup";
import { reflowSpacedGlyphs } from "@/lib/text-reflow";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_PER_REQUEST = 500;

const bodySchema = z.object({
  sentences: z
    .array(
      z.object({
        idx: z.number().int().min(0).max(200_000),
        page: z.number().int().min(1).max(10_000),
        text: z.string().min(1).max(2_000),
      }),
    )
    .min(1)
    .max(MAX_PER_REQUEST),
});

type RouteContext = { params: Promise<{ id: string }> };

export async function POST(req: Request, { params }: RouteContext) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { id: bookId } = await params;
  if (!isUuid(bookId)) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = bodySchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid body" },
      { status: 400 },
    );
  }

  const db = getDb();

  // Confirm the book exists AND belongs to the caller, and read its declared
  // sentenceCount so we can refuse out-of-range idx values. One query.
  const owned = await db
    .select({
      id: schema.books.id,
      sentenceCount: schema.books.sentenceCount,
    })
    .from(schema.books)
    .where(
      and(
        eq(schema.books.id, bookId),
        eq(schema.books.userId, session.user.id),
      ),
    )
    .limit(1);
  if (owned.length === 0) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const declared = owned[0].sentenceCount;

  const outOfRange = parsed.data.sentences.some((s) => s.idx >= declared);
  if (outOfRange) {
    return NextResponse.json(
      { error: "Sentence idx out of declared range." },
      { status: 400 },
    );
  }

  // Defensive double-pass: reflowSpacedGlyphs catches letter-tracked
  // titles ("N i n e" → "Nine"), cleanSentenceText strips italic
  // underscores, footnote markers, illustration blocks. Idempotent — a
  // properly-cleaned client payload passes through unchanged. We do NOT
  // run the drop heuristics here because the client already reasons over
  // book-wide context (idx position relative to total) when deciding
  // what to skip; running them again with partial-batch context risks
  // creating gaps the client didn't intend. We do skip rows whose text
  // collapses to empty (pure markup) since inserting empty text would
  // produce a silent slot in the reader.
  const rows = parsed.data.sentences
    .map((s) => {
      const reflowed = reflowSpacedGlyphs(s.text);
      const cleaned = cleanSentenceText(reflowed);
      if (cleaned !== s.text) {
        console.info("[sentences] cleanup applied", {
          bookId,
          idx: s.idx,
          beforeLen: s.text.length,
          afterLen: cleaned.length,
        });
      }
      return { bookId, idx: s.idx, page: s.page, text: cleaned };
    })
    .filter((r) => r.text.length > 0);

  if (rows.length === 0) {
    return NextResponse.json({ inserted: 0 });
  }

  const inserted = await db
    .insert(schema.bookSentences)
    .values(rows)
    .onConflictDoNothing()
    .returning({ idx: schema.bookSentences.idx });

  return NextResponse.json({ inserted: inserted.length });
}
