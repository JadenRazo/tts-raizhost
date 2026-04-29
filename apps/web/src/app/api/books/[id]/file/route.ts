// GET /api/books/:id/file — stream the original PDF for the reader.
//
// Returns 404 (not 403) when the caller doesn't own the book.

import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";

import { getSession } from "@/lib/auth/session";
import { getDb, schema } from "@/lib/db";
import { bookFileSize, isUuid, streamBook } from "@/lib/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

function quoteFilename(name: string): string {
  // RFC 6266: quoted-string with backslash escapes for " and \. Strip CR/LF
  // entirely so the header can never be split.
  return name.replace(/[\r\n]/g, "").replace(/(["\\])/g, "\\$1");
}

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
  const rows = await db
    .select({
      id: schema.books.id,
      originalFilename: schema.books.originalFilename,
      byteSize: schema.books.byteSize,
    })
    .from(schema.books)
    .where(and(eq(schema.books.id, bookId), eq(schema.books.userId, userId)))
    .limit(1);
  const book = rows[0];
  if (!book) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  // Confirm the file actually exists on disk before opening the stream;
  // otherwise the response would 200-then-error mid-flight.
  const onDiskSize = await bookFileSize(userId, bookId);
  if (onDiskSize === null) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const stream = streamBook(userId, bookId);
  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "application/pdf",
      "Content-Length": String(onDiskSize),
      "Content-Disposition": `inline; filename="${quoteFilename(book.originalFilename)}"`,
      "Cache-Control": "private, max-age=0, must-revalidate",
      // PDFs may carry JS / forms / external refs. Sandbox the response so
      // that even if the browser renders inline in the same origin, the
      // document can't reach back into the session via fetch/XHR/forms.
      "Content-Security-Policy": "sandbox; default-src 'none'",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
    },
  });
}
