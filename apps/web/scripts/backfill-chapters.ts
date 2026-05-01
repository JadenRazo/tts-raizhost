// Backfill book_chapters for books uploaded before chapter extraction
// shipped. Reads the original PDF from disk, walks pdfjs-dist's outline,
// resolves each entry to a 1-based page number, then to the first
// sentence idx on or after that page (using the existing book_sentences
// rows as the page→idx oracle so we don't re-segment text).
//
// Idempotent: replaces the chapter set for each book on each run. Safe
// to re-run after refining heuristics.
//
// Usage:
//   npm --prefix apps/web exec tsx scripts/backfill-chapters.ts -- --book <uuid>
//   npm --prefix apps/web exec tsx scripts/backfill-chapters.ts -- --all
//   npm --prefix apps/web exec tsx scripts/backfill-chapters.ts -- --all --dry-run
//   npm --prefix apps/web exec tsx scripts/backfill-chapters.ts -- --all --skip-existing

import fs from "node:fs/promises";
import { asc, eq } from "drizzle-orm";

import { getDb } from "../src/lib/db";
import * as schema from "../src/lib/db/schema";

const BOOKS_HOST_DIR =
  process.env.BOOKS_HOST_DIR ?? "/var/lib/tts-raizhost/books";

type Args = {
  bookId: string | null;
  all: boolean;
  dryRun: boolean;
  skipExisting: boolean;
};

function parseArgs(argv: string[]): Args {
  const a: Args = {
    bookId: null,
    all: false,
    dryRun: false,
    skipExisting: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    if (v === "--book" || v === "-b") a.bookId = argv[++i] ?? null;
    else if (v === "--all") a.all = true;
    else if (v === "--dry-run" || v === "-n") a.dryRun = true;
    else if (v === "--skip-existing") a.skipExisting = true;
    else if (v === "--help" || v === "-h") {
      console.log(
        "Usage: backfill-chapters [--book <uuid> | --all] [--dry-run] [--skip-existing]\n",
      );
      process.exit(0);
    }
  }
  if (!a.bookId && !a.all) {
    console.error("error: pass --book <uuid> or --all");
    process.exit(1);
  }
  return a;
}

function dbPathToHostPath(filePath: string): string {
  if (filePath.startsWith("/data/books/")) {
    return filePath.replace(/^\/data\/books/, BOOKS_HOST_DIR);
  }
  return filePath;
}

type Chapter = {
  title: string;
  startSentenceIdx: number;
  depth: number;
  ord: number;
};

async function extractChaptersForBook(
  bookId: string,
  dryRun: boolean,
): Promise<{
  bookTitle: string;
  chapterCount: number;
  preview: string[];
} | null> {
  const db = getDb();

  const bookRows = await db
    .select({
      id: schema.books.id,
      title: schema.books.title,
      filePath: schema.books.filePath,
    })
    .from(schema.books)
    .where(eq(schema.books.id, bookId))
    .limit(1);
  if (bookRows.length === 0) {
    throw new Error(`book ${bookId} not found`);
  }
  const book = bookRows[0];

  // Build page → first-sentence-idx from the existing book_sentences
  // rows. Sentences within a page are stored in idx order, so the first
  // row encountered for each page is its first sentence.
  const sentenceRows = await db
    .select({
      idx: schema.bookSentences.idx,
      page: schema.bookSentences.page,
    })
    .from(schema.bookSentences)
    .where(eq(schema.bookSentences.bookId, bookId))
    .orderBy(asc(schema.bookSentences.idx));

  if (sentenceRows.length === 0) {
    console.warn(`  skipping ${bookId}: no sentences in DB`);
    return null;
  }

  const firstIdxByPage = new Map<number, number>();
  for (const s of sentenceRows) {
    if (!firstIdxByPage.has(s.page)) firstIdxByPage.set(s.page, s.idx);
  }
  const knownPages = [...firstIdxByPage.keys()].sort((a, b) => a - b);
  function firstIdxAtOrAfter(page: number): number | null {
    for (const p of knownPages) {
      if (p >= page) return firstIdxByPage.get(p) ?? null;
    }
    return null;
  }

  const hostPath = dbPathToHostPath(book.filePath);
  const buf = await fs.readFile(hostPath);

  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const data = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  const doc = await pdfjs.getDocument({
    data,
    isEvalSupported: false,
    useSystemFonts: true,
  }).promise;

  let outline: Awaited<ReturnType<typeof doc.getOutline>> | null = null;
  try {
    outline = await doc.getOutline();
  } catch {
    outline = null;
  }

  const chapters: Chapter[] = [];
  let ord = 0;

  if (outline && outline.length > 0) {
    type OutlineNode = NonNullable<typeof outline>[number];

    async function resolvePageNumber(node: OutlineNode): Promise<number | null> {
      let dest = node.dest;
      if (!dest) return null;
      if (typeof dest === "string") {
        try {
          dest = await doc.getDestination(dest);
        } catch {
          return null;
        }
      }
      if (!Array.isArray(dest) || dest.length === 0) return null;
      const pageRef = dest[0];
      if (!pageRef) return null;
      try {
        const pageIndex =
          typeof pageRef === "number"
            ? pageRef
            : await doc.getPageIndex(pageRef);
        return pageIndex + 1;
      } catch {
        return null;
      }
    }

    async function walk(node: OutlineNode, depth: number): Promise<void> {
      const title = (node.title ?? "").trim();
      if (!title) {
        for (const child of node.items ?? []) await walk(child, depth + 1);
        return;
      }
      const pageNumber = await resolvePageNumber(node);
      if (pageNumber !== null) {
        const startIdx = firstIdxAtOrAfter(pageNumber);
        if (startIdx !== null) {
          const prev = chapters[chapters.length - 1];
          if (!prev || prev.startSentenceIdx !== startIdx) {
            chapters.push({
              title,
              startSentenceIdx: startIdx,
              depth,
              ord: ord++,
            });
          }
        }
      }
      for (const child of node.items ?? []) await walk(child, depth + 1);
    }

    for (const top of outline) await walk(top, 0);
  }

  await doc.destroy();

  const preview = chapters
    .slice(0, 8)
    .map(
      (c) =>
        `${"  ".repeat(c.depth)}${c.title} → idx ${c.startSentenceIdx}`,
    );

  if (!dryRun) {
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
  }

  return {
    bookTitle: book.title,
    chapterCount: chapters.length,
    preview,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const db = getDb();

  let ids: string[];
  if (args.all) {
    const rows = await db.select({ id: schema.books.id }).from(schema.books);
    ids = rows.map((r) => r.id);
  } else {
    ids = [args.bookId!];
  }

  if (args.skipExisting) {
    const existing = await db
      .select({ bookId: schema.bookChapters.bookId })
      .from(schema.bookChapters);
    const have = new Set(existing.map((r) => r.bookId));
    ids = ids.filter((id) => !have.has(id));
  }

  let totalChapters = 0;
  for (const id of ids) {
    console.log(`\n=== ${id} ${args.dryRun ? "(DRY RUN)" : ""} ===`);
    try {
      const r = await extractChaptersForBook(id, args.dryRun);
      if (!r) continue;
      console.log(`  title:    ${r.bookTitle}`);
      console.log(`  chapters: ${r.chapterCount}`);
      for (const p of r.preview) console.log(`    ${p}`);
      totalChapters += r.chapterCount;
    } catch (err) {
      console.error(`  FAILED:`, err instanceof Error ? err.message : err);
    }
  }
  console.log(`\nTotal chapters across ${ids.length} books: ${totalChapters}`);

  process.exit(0);
}

main().catch((err) => {
  console.error("backfill-chapters failed:", err);
  process.exit(1);
});
