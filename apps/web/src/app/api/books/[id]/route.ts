// DELETE /api/books/:id — remove the book row, cascade sentences and
// reading positions, best-effort delete the on-disk file.
//
// Returns 404 (never 403) when the book belongs to someone else, so an
// attacker can't enumerate book ids through differential responses.

import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";

import { getSession } from "@/lib/auth/session";
import { getDb, schema } from "@/lib/db";
import { deleteBook, isUuid } from "@/lib/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

export async function DELETE(_req: Request, { params }: RouteContext) {
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
  const existing = await db
    .select({ id: schema.books.id })
    .from(schema.books)
    .where(and(eq(schema.books.id, bookId), eq(schema.books.userId, userId)))
    .limit(1);

  if (existing.length === 0) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  // Delete the DB row first — if the file unlink fails, the row's already
  // gone, so the user sees "deleted" and a stale file remains for the
  // nightly cleanup. Better than a row that points at a missing file.
  await db
    .delete(schema.books)
    .where(and(eq(schema.books.id, bookId), eq(schema.books.userId, userId)));

  try {
    await deleteBook(userId, bookId);
  } catch (err) {
    console.error("[books.DELETE] file unlink failed", err);
  }

  return NextResponse.json({ ok: true });
}
