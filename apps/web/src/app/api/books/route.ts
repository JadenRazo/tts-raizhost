// Library API:
//   GET  /api/books — list signed-in user's books
//   POST /api/books — multipart upload of a PDF + metadata
//
// The cap enforcement (5 books, 250 MB total per user) is applied inside a
// serializable transaction with a count + sum check before insert. The pre-
// flight assertWithinLimits() short-circuits obvious rejections before we
// spend disk on a doomed write; the transactional check is the authoritative
// one and protects against concurrent uploads racing past the cap.

import crypto from "node:crypto";
import { desc, eq, sql } from "drizzle-orm";
import { NextResponse } from "next/server";
import { z } from "zod";

import { getSession } from "@/lib/auth/session";
import {
  LimitExceededError,
  MAX_BOOKS_PER_USER,
  MAX_FILE_BYTES,
  MAX_TOTAL_BYTES,
  assertWithinLimits,
} from "@/lib/books";
import { getDb, schema } from "@/lib/db";
import { bookPath, deleteBook, writeBook } from "@/lib/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PDF_MAGIC = Buffer.from("%PDF-");
const PDF_EOF = Buffer.from("%%EOF");

const metadataSchema = z.object({
  title: z.string().trim().min(1).max(500),
  author: z
    .string()
    .trim()
    .max(500)
    .optional()
    .transform((v) => (v && v.length > 0 ? v : null)),
  pageCount: z.number().int().min(1).max(10_000),
  sentenceCount: z.number().int().min(1).max(200_000),
  textSha256: z
    .string()
    .regex(/^[0-9a-f]{64}$/i, "textSha256 must be 64 hex chars"),
});

function badRequest(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status });
}

export async function GET() {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const db = getDb();
  const rows = await db
    .select({
      id: schema.books.id,
      title: schema.books.title,
      author: schema.books.author,
      originalFilename: schema.books.originalFilename,
      byteSize: schema.books.byteSize,
      pageCount: schema.books.pageCount,
      sentenceCount: schema.books.sentenceCount,
      uploadedAt: schema.books.uploadedAt,
      lastOpenedAt: schema.books.lastOpenedAt,
    })
    .from(schema.books)
    .where(eq(schema.books.userId, session.user.id))
    .orderBy(
      sql`${schema.books.lastOpenedAt} desc nulls last`,
      desc(schema.books.uploadedAt),
    );
  return NextResponse.json({ books: rows });
}

export async function POST(req: Request) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const userId = session.user.id;

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return badRequest("Expected multipart/form-data");
  }

  const file = form.get("file");
  if (!(file instanceof File)) {
    return badRequest("Missing file");
  }
  if (file.size === 0) {
    return badRequest("File is empty");
  }
  if (file.size > MAX_FILE_BYTES) {
    return NextResponse.json(
      {
        error: `File exceeds the ${Math.round(MAX_FILE_BYTES / 1024 / 1024)} MB per-file limit.`,
      },
      { status: 413 },
    );
  }

  const raw = {
    title: String(form.get("title") ?? ""),
    author: form.get("author") ? String(form.get("author")) : undefined,
    pageCount: Number(form.get("pageCount")),
    sentenceCount: Number(form.get("sentenceCount")),
    textSha256: String(form.get("textSha256") ?? ""),
  };
  const parsed = metadataSchema.safeParse(raw);
  if (!parsed.success) {
    return badRequest(parsed.error.issues[0]?.message ?? "Invalid metadata");
  }
  const meta = parsed.data;

  const buf = Buffer.from(await file.arrayBuffer());
  const declaredType = file.type;
  const looksLikePdf = buf.subarray(0, 5).equals(PDF_MAGIC);
  if (declaredType !== "application/pdf" && !looksLikePdf) {
    return NextResponse.json(
      { error: "Only PDF files are accepted." },
      { status: 415 },
    );
  }
  if (!looksLikePdf) {
    return NextResponse.json(
      { error: "File does not look like a PDF." },
      { status: 415 },
    );
  }
  // %%EOF must appear in the trailing 1 KiB of a real PDF. Polyglots that
  // start with %PDF- but aren't actually well-formed get rejected here.
  const tail = buf.subarray(Math.max(0, buf.byteLength - 1024));
  if (tail.indexOf(PDF_EOF) === -1) {
    return NextResponse.json(
      { error: "PDF appears truncated or malformed." },
      { status: 415 },
    );
  }

  const db = getDb();
  try {
    await assertWithinLimits(db, userId, buf.byteLength);
  } catch (err) {
    if (err instanceof LimitExceededError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    throw err;
  }

  const bookId = crypto.randomUUID();
  const filePath = bookPath(userId, bookId);

  try {
    await writeBook(userId, bookId, buf);
  } catch (err) {
    console.error("[books.POST] writeBook failed", err);
    return NextResponse.json(
      { error: "Failed to write file to storage." },
      { status: 500 },
    );
  }

  // Authoritative cap check happens here, inside a serializable transaction.
  // Any concurrent upload that read the same count/bytes earlier will fail
  // its own commit and retry / 409 cleanly.
  let inserted = false;
  try {
    await db.transaction(
      async (tx) => {
        const usage = await tx
          .select({
            count: sql<number>`count(*)::int`,
            total: sql<number>`coalesce(sum(${schema.books.byteSize}), 0)::bigint`,
          })
          .from(schema.books)
          .where(eq(schema.books.userId, userId));
        const u = usage[0] ?? { count: 0, total: 0 };
        const usedBytes =
          typeof u.total === "string" ? Number(u.total) : (u.total ?? 0);
        if ((u.count ?? 0) >= MAX_BOOKS_PER_USER) {
          throw new LimitExceededError(
            "BOOK_LIMIT",
            "Storage limit reached. Delete a book to upload another.",
          );
        }
        if (usedBytes + buf.byteLength > MAX_TOTAL_BYTES) {
          throw new LimitExceededError(
            "STORAGE_LIMIT",
            `Total storage cap of ${Math.round(MAX_TOTAL_BYTES / 1024 / 1024)} MB would be exceeded.`,
          );
        }
        await tx.insert(schema.books).values({
          id: bookId,
          userId,
          title: meta.title,
          author: meta.author,
          originalFilename: file.name || `${bookId}.pdf`,
          filePath,
          byteSize: buf.byteLength,
          pageCount: meta.pageCount,
          sentenceCount: meta.sentenceCount,
          textSha256: meta.textSha256,
        });
      },
      { isolationLevel: "serializable" },
    );
    inserted = true;
  } catch (err) {
    await deleteBook(userId, bookId).catch(() => undefined);
    if (err instanceof LimitExceededError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    console.error("[books.POST] insert failed", err);
    return NextResponse.json(
      { error: "Failed to save book." },
      { status: 500 },
    );
  }
  if (!inserted) {
    await deleteBook(userId, bookId).catch(() => undefined);
    return NextResponse.json(
      { error: "Failed to save book." },
      { status: 500 },
    );
  }

  return NextResponse.json(
    { id: bookId, remaining: MAX_BOOKS_PER_USER },
    { status: 201 },
  );
}
