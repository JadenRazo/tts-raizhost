// Authenticated library view. Server component — fetches the user's books
// and the curated public-domain library, renders both, plus a
// remaining-capacity hint. Per-row delete is handled by the BookRow
// client component (suppressed for the read-only Featured section).

import { asc, desc, eq, sql } from "drizzle-orm";
import Link from "next/link";

import { SignOutButton } from "../sign-out-button";
import { BookRow } from "./book-row";
import {
  MAX_BOOKS_PER_USER,
  MAX_FILE_BYTES,
  getUserStorageUsed,
} from "@/lib/books";
import { getDb, schema } from "@/lib/db";

type Props = {
  userId: string;
  email: string;
};

function formatMB(bytes: number): string {
  return (bytes / 1024 / 1024).toFixed(1);
}

export async function LibraryView({ userId, email }: Props) {
  const db = getDb();
  const [books, publicBooks, storageUsed] = await Promise.all([
    db
      .select({
        id: schema.books.id,
        title: schema.books.title,
        author: schema.books.author,
        pageCount: schema.books.pageCount,
        byteSize: schema.books.byteSize,
        uploadedAt: schema.books.uploadedAt,
        lastOpenedAt: schema.books.lastOpenedAt,
      })
      .from(schema.books)
      .where(eq(schema.books.userId, userId))
      .orderBy(
        sql`${schema.books.lastOpenedAt} desc nulls last`,
        desc(schema.books.uploadedAt),
      ),
    db
      .select({
        id: schema.books.id,
        title: schema.books.title,
        author: schema.books.author,
        pageCount: schema.books.pageCount,
      })
      .from(schema.books)
      .where(eq(schema.books.isPublic, true))
      .orderBy(asc(schema.books.title)),
    getUserStorageUsed(db, userId),
  ]);

  const totalCap = MAX_BOOKS_PER_USER * MAX_FILE_BYTES;

  return (
    <main className="mx-auto max-w-2xl px-6 py-12">
      <header className="flex items-center justify-between">
        <div>
          <p className="text-sm text-muted">Signed in as {email}</p>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight text-fg">
            Your library
          </h1>
        </div>
        <div className="flex items-center gap-4">
          <Link
            href="/upload"
            className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-accent-fg transition-colors hover:bg-accent-hover"
          >
            Upload
          </Link>
          <SignOutButton />
        </div>
      </header>

      {publicBooks.length > 0 ? (
        <section className="mt-10">
          <div className="flex items-baseline justify-between">
            <h2 className="text-sm font-medium text-fg">Featured library</h2>
            <p className="text-xs text-subtle">
              Public domain · free to read for everyone
            </p>
          </div>
          <ul className="mt-3 divide-y divide-border rounded-lg border border-border">
            {publicBooks.map((b) => (
              <li key={b.id}>
                <BookRow
                  id={b.id}
                  title={b.title}
                  author={b.author}
                  pageCount={b.pageCount}
                  uploadedAt=""
                  readOnly
                />
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {books.length === 0 ? (
        <section className="mt-10 rounded-lg border border-border bg-surface px-8 py-12 text-center">
          <h2 className="text-base font-medium text-fg">Your library is empty</h2>
          <p className="mt-2 text-sm text-muted">
            Upload a PDF to add it here. You can store up to{" "}
            {MAX_BOOKS_PER_USER} books, {formatMB(MAX_FILE_BYTES)} MB each.
          </p>
          <Link
            href="/upload"
            className="mt-6 inline-block rounded-md bg-accent px-4 py-2 text-sm font-medium text-accent-fg transition-colors hover:bg-accent-hover"
          >
            Upload a PDF
          </Link>
        </section>
      ) : (
        <section className="mt-10">
          <div className="flex items-baseline justify-between">
            <h2 className="text-sm font-medium text-fg">Your books</h2>
            <p className="text-xs text-subtle">
              {books.length} / {MAX_BOOKS_PER_USER} ·{" "}
              {formatMB(storageUsed)} of {formatMB(totalCap)} MB
            </p>
          </div>
          <ul className="mt-3 divide-y divide-border rounded-lg border border-border">
            {books.map((b) => (
              <li key={b.id}>
                <BookRow
                  id={b.id}
                  title={b.title}
                  author={b.author}
                  pageCount={b.pageCount}
                  uploadedAt={
                    b.uploadedAt instanceof Date
                      ? b.uploadedAt.toISOString()
                      : String(b.uploadedAt)
                  }
                />
              </li>
            ))}
          </ul>
        </section>
      )}
    </main>
  );
}
