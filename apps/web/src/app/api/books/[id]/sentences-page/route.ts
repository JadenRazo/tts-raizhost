// GET /api/books/:id/sentences-page?from=&limit= — paginated read of
// parsed sentences. The reader server-renders the first 50 and lazy-fetches
// the rest as the user scrolls.
//
// Returns 404 (not 403) when the caller doesn't own the book.

import { and, asc, eq, gte } from "drizzle-orm";
import { NextResponse } from "next/server";

import { getSession } from "@/lib/auth/session";
import { userCanReadBook } from "@/lib/books";
import { getDb, schema } from "@/lib/db";
import { sentencesPageDurationSeconds, startTimer } from "@/lib/metrics";
import { isUuid } from "@/lib/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const MAX_FROM = 200_000;

export async function GET(req: Request, { params }: RouteContext) {
  const elapsed = startTimer();
  const observe = (status: number) =>
    sentencesPageDurationSeconds.labels({ status: String(status) }).observe(elapsed());

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

  const url = new URL(req.url);
  const fromRaw = url.searchParams.get("from") ?? "0";
  const limitRaw = url.searchParams.get("limit") ?? String(DEFAULT_LIMIT);

  const from = Number(fromRaw);
  if (!Number.isInteger(from) || from < 0 || from > MAX_FROM) {
    observe(400);
    return NextResponse.json({ error: "Invalid from" }, { status: 400 });
  }
  const limit = Number(limitRaw);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    observe(400);
    return NextResponse.json({ error: "Invalid limit" }, { status: 400 });
  }

  const db = getDb();

  const owned = await db
    .select({ id: schema.books.id })
    .from(schema.books)
    .where(and(eq(schema.books.id, bookId), userCanReadBook(userId)))
    .limit(1);
  if (owned.length === 0) {
    observe(404);
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  // Fetch limit+1 to detect hasMore without a separate count query.
  const rows = await db
    .select({
      idx: schema.bookSentences.idx,
      page: schema.bookSentences.page,
      text: schema.bookSentences.text,
    })
    .from(schema.bookSentences)
    .where(
      and(
        eq(schema.bookSentences.bookId, bookId),
        gte(schema.bookSentences.idx, from),
      ),
    )
    .orderBy(asc(schema.bookSentences.idx))
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const sentences = hasMore ? rows.slice(0, limit) : rows;

  observe(200);
  return NextResponse.json(
    { sentences, hasMore },
    {
      headers: {
        // Sentences are immutable once parsed (re-uploads create new bookId),
        // but the response is per-user via the auth filter, so private + a
        // short max-age is plenty.
        "Cache-Control": "private, max-age=60",
      },
    },
  );
}
