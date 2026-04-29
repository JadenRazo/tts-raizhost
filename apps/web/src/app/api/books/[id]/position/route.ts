// Reading position API:
//   GET  /api/books/:id/position   -> { sentenceIdx, charOffset }
//   PUT  /api/books/:id/position   <- { sentenceIdx, charOffset }
//
// Returns 404 (not 403) when the caller doesn't own the book, mirroring
// the rest of the books API to avoid leaking ids.

import { and, eq, sql } from "drizzle-orm";
import { NextResponse } from "next/server";
import { z } from "zod";

import { getSession } from "@/lib/auth/session";
import { userCanReadBook } from "@/lib/books";
import { getDb, schema } from "@/lib/db";
import { positionSaveDurationSeconds, startTimer } from "@/lib/metrics";
import { isUuid } from "@/lib/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

const bodySchema = z.object({
  sentenceIdx: z.number().int().min(0).max(200_000),
  charOffset: z.number().int().min(0).max(10_000),
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
      sentenceIdx: schema.readingPositions.sentenceIdx,
      charOffset: schema.readingPositions.charOffset,
    })
    .from(schema.readingPositions)
    .where(
      and(
        eq(schema.readingPositions.userId, userId),
        eq(schema.readingPositions.bookId, bookId),
      ),
    )
    .limit(1);

  const pos = rows[0] ?? { sentenceIdx: 0, charOffset: 0 };
  return NextResponse.json(pos);
}

export async function PUT(req: Request, { params }: RouteContext) {
  const elapsed = startTimer();
  const observe = (status: number) =>
    positionSaveDurationSeconds.labels({ status: String(status) }).observe(elapsed());

  const session = await getSession();
  if (!session) {
    observe(401);
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { id: bookId } = await params;
  if (!isUuid(bookId)) {
    observe(404);
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const userId = session.user.id;

  let json: unknown;
  try {
    json = await req.json();
  } catch {
    observe(400);
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const parsed = bodySchema.safeParse(json);
  if (!parsed.success) {
    observe(400);
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid body" },
      { status: 400 },
    );
  }
  const { sentenceIdx, charOffset } = parsed.data;

  const db = getDb();

  // One transaction:
  //  1) confirm ownership + read sentenceCount for range check
  //  2) upsert reading_positions
  //  3) bump books.lastOpenedAt so the library's recency ordering reflects use
  type TxResult = "ok" | "not-found" | "out-of-range";
  let result = "ok" as TxResult;
  await db.transaction(async (tx) => {
    const rows = await tx
      .select({
        id: schema.books.id,
        sentenceCount: schema.books.sentenceCount,
      })
      .from(schema.books)
      .where(and(eq(schema.books.id, bookId), userCanReadBook(userId)))
      .limit(1);
    if (rows.length === 0) {
      result = "not-found";
      return;
    }
    if (sentenceIdx >= rows[0].sentenceCount) {
      result = "out-of-range";
      return;
    }

    await tx
      .insert(schema.readingPositions)
      .values({ userId, bookId, sentenceIdx, charOffset })
      .onConflictDoUpdate({
        target: [
          schema.readingPositions.userId,
          schema.readingPositions.bookId,
        ],
        set: {
          sentenceIdx,
          charOffset,
          updatedAt: sql`now()`,
        },
      });

    await tx
      .update(schema.books)
      .set({ lastOpenedAt: sql`now()` })
      .where(and(eq(schema.books.id, bookId), eq(schema.books.userId, userId)));
  });

  if (result === "not-found") {
    observe(404);
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  if (result === "out-of-range") {
    observe(400);
    return NextResponse.json(
      { error: "sentenceIdx out of range" },
      { status: 400 },
    );
  }

  observe(204);
  return new Response(null, { status: 204 });
}
