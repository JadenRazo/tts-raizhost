// Chapters API for a book.
//   GET  /api/books/:id/chapters   -> { chapters: [...] } ordered by `ord`
//   POST /api/books/:id/chapters   <- { chapters: [...] }
//
// POST replaces the chapter set for the book (it's authored by the
// upload pipeline and re-uploaded if the user re-runs the parse).
// Bookmarks are unrelated and untouched.

import { and, asc, eq, sql } from "drizzle-orm";
import { NextResponse } from "next/server";
import { z } from "zod";

import { getSession } from "@/lib/auth/session";
import { userCanReadBook } from "@/lib/books";
import { getDb, schema } from "@/lib/db";
import { isUuid } from "@/lib/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

const MAX_CHAPTERS_PER_BOOK = 5_000;
const MAX_TITLE_LEN = 500;
const MAX_DEPTH = 10;

const postSchema = z.object({
  chapters: z
    .array(
      z.object({
        title: z.string().min(1).max(MAX_TITLE_LEN),
        startSentenceIdx: z.number().int().min(0).max(200_000),
        depth: z.number().int().min(0).max(MAX_DEPTH),
        ord: z.number().int().min(0),
      }),
    )
    .max(MAX_CHAPTERS_PER_BOOK),
});

export async function GET(_req: Request, { params }: RouteContext) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { id: bookId } = await params;
  if (!isUuid(bookId)) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const userId = session.user.id;

  const db = getDb();
  const owned = await db
    .select({ id: schema.books.id })
    .from(schema.books)
    .where(and(eq(schema.books.id, bookId), userCanReadBook(userId)))
    .limit(1);
  if (owned.length === 0) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const rows = await db
    .select({
      id: schema.bookChapters.id,
      title: schema.bookChapters.title,
      startSentenceIdx: schema.bookChapters.startSentenceIdx,
      depth: schema.bookChapters.depth,
      ord: schema.bookChapters.ord,
    })
    .from(schema.bookChapters)
    .where(eq(schema.bookChapters.bookId, bookId))
    .orderBy(asc(schema.bookChapters.ord));

  return NextResponse.json({ chapters: rows });
}

export async function POST(req: Request, { params }: RouteContext) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { id: bookId } = await params;
  if (!isUuid(bookId)) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const userId = session.user.id;

  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const parsed = postSchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid body" },
      { status: 400 },
    );
  }
  const { chapters } = parsed.data;

  const db = getDb();

  // Confirm ownership AND read the sentenceCount in one trip so we can
  // reject chapters that point past the end of the book. POST is only
  // ever made by the book's owner (uploader); userCanReadBook is
  // intentionally not used here — public-domain books are read-only
  // and shouldn't accept chapter mutations from arbitrary callers.
  const ownedRows = await db
    .select({
      id: schema.books.id,
      sentenceCount: schema.books.sentenceCount,
      ownerId: schema.books.userId,
    })
    .from(schema.books)
    .where(eq(schema.books.id, bookId))
    .limit(1);
  if (ownedRows.length === 0 || ownedRows[0].ownerId !== userId) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const sentenceCount = ownedRows[0].sentenceCount;

  for (const c of chapters) {
    if (c.startSentenceIdx >= sentenceCount) {
      return NextResponse.json(
        { error: "startSentenceIdx out of range" },
        { status: 400 },
      );
    }
  }

  // Replace the chapter set in one transaction so a partial overwrite
  // can't leave the book with a stale + new mix.
  await db.transaction(async (tx) => {
    await tx
      .delete(schema.bookChapters)
      .where(eq(schema.bookChapters.bookId, bookId));
    if (chapters.length > 0) {
      await tx.insert(schema.bookChapters).values(
        chapters.map((c) => ({
          bookId,
          title: c.title,
          startSentenceIdx: c.startSentenceIdx,
          depth: c.depth,
          ord: c.ord,
        })),
      );
    }
  });

  return new Response(null, { status: 204 });
}
