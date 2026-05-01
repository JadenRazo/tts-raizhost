// GET /api/books/:id/sentence-meta — return (idx, page) for every
// sentence in the book in a single response.
//
// Used by the reader's client-side chapter backfill so it can map a
// PDF outline entry's page number to the first sentence-idx on that
// page. We strip text intentionally — even a 5000-sentence book is
// ~40KB at 8 bytes per row, vs. several MB if we shipped text too.

import { and, asc, eq } from "drizzle-orm";
import { NextResponse } from "next/server";

import { getSession } from "@/lib/auth/session";
import { userCanReadBook } from "@/lib/books";
import { getDb, schema } from "@/lib/db";
import { isUuid } from "@/lib/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

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
      idx: schema.bookSentences.idx,
      page: schema.bookSentences.page,
    })
    .from(schema.bookSentences)
    .where(eq(schema.bookSentences.bookId, bookId))
    .orderBy(asc(schema.bookSentences.idx));

  return NextResponse.json({ meta: rows });
}
