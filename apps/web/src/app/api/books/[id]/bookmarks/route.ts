// Bookmarks API:
//   GET  /api/books/:id/bookmarks   -> { bookmarks: [{id, sentenceIdx, note, createdAt}, ...] }
//   POST /api/books/:id/bookmarks   <- { sentenceIdx, note? } -> { bookmark }
//
// Newest-first. Returns 404 (not 403) when the caller doesn't own the
// book, mirroring the rest of the books API.

import { and, asc, desc, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { z } from "zod";

import { getSession } from "@/lib/auth/session";
import { userCanReadBook } from "@/lib/books";
import { getDb, schema } from "@/lib/db";
import { isUuid } from "@/lib/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

const createSchema = z.object({
  sentenceIdx: z.number().int().min(0).max(200_000),
  note: z.string().max(500).optional(),
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
      id: schema.bookmarks.id,
      sentenceIdx: schema.bookmarks.sentenceIdx,
      note: schema.bookmarks.note,
      createdAt: schema.bookmarks.createdAt,
    })
    .from(schema.bookmarks)
    .where(
      and(
        eq(schema.bookmarks.userId, userId),
        eq(schema.bookmarks.bookId, bookId),
      ),
    )
    // Order by sentence position, with creation time as a stable tiebreaker
    // so two bookmarks on the same sentence keep a deterministic order.
    .orderBy(asc(schema.bookmarks.sentenceIdx), desc(schema.bookmarks.createdAt));

  return NextResponse.json({
    bookmarks: rows.map((r) => ({
      ...r,
      createdAt: r.createdAt.toISOString(),
    })),
  });
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
  const parsed = createSchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid body" },
      { status: 400 },
    );
  }
  const { sentenceIdx, note } = parsed.data;

  const db = getDb();
  // Ownership + range check in one query.
  const rows = await db
    .select({ sentenceCount: schema.books.sentenceCount })
    .from(schema.books)
    .where(and(eq(schema.books.id, bookId), userCanReadBook(userId)))
    .limit(1);
  if (rows.length === 0) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  if (sentenceIdx >= rows[0].sentenceCount) {
    return NextResponse.json(
      { error: "sentenceIdx out of range" },
      { status: 400 },
    );
  }

  const inserted = await db
    .insert(schema.bookmarks)
    .values({ userId, bookId, sentenceIdx, note: note ?? null })
    .returning({
      id: schema.bookmarks.id,
      sentenceIdx: schema.bookmarks.sentenceIdx,
      note: schema.bookmarks.note,
      createdAt: schema.bookmarks.createdAt,
    });

  const row = inserted[0];
  return NextResponse.json(
    {
      bookmark: {
        ...row,
        createdAt: row.createdAt.toISOString(),
      },
    },
    { status: 201 },
  );
}
