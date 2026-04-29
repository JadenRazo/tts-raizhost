// Server-side rescan: re-extract a book's sentences from the original PDF
// using the new flowTextItems + reflowSpacedGlyphs pipeline. Replaces the
// existing book_sentences rows for that book in place, preserving the
// books row (so the user's reading position remains valid against the
// regenerated sentence index).
//
// Why this exists: the original extractor lived in the browser (pdfjs-dist
// is loaded client-side) and did .map(item => item.str).join(" "). For
// letter-tracked chapter titles ("Nine suggestions ..."), this produced
// "N i n e   s u g g e s t i o n s ..." which then got collapsed to
// single spaces by normalizeWhitespace, destroying word boundaries. The
// new pipeline uses item geometry to detect real word breaks before any
// collapse. Existing book rows can't be fixed by a string-only reflow
// because the boundary info is already gone — they need re-extraction
// from the source PDF, which is what this script does.
//
// Translates DB-stored container paths (/data/books/...) to host paths
// (BOOKS_HOST_DIR or default /var/lib/tts-raizhost/books) automatically.
//
// Usage:
//   npm --prefix apps/web exec tsx scripts/rescan-pdf.ts -- --book <uuid>
//   npm --prefix apps/web exec tsx scripts/rescan-pdf.ts -- --all
//   npm --prefix apps/web exec tsx scripts/rescan-pdf.ts -- --all --dry-run

import fs from "node:fs/promises";
import { and, eq } from "drizzle-orm";

import { getDb } from "../src/lib/db";
import * as schema from "../src/lib/db/schema";
import {
  flowTextItems,
  reflowSpacedGlyphs,
  type RawTextItem,
} from "../src/lib/text-reflow";

const SENTENCE_SPLIT = /(?<=[.!?])\s+(?=[A-Z"“«(])/;
const MIN_SENTENCE_LEN = 3;
const MAX_SENTENCE_LEN = 1500;

const BOOKS_HOST_DIR = process.env.BOOKS_HOST_DIR ?? "/var/lib/tts-raizhost/books";

type Args = { bookId: string | null; all: boolean; dryRun: boolean };

function parseArgs(argv: string[]): Args {
  const a: Args = { bookId: null, all: false, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    if (v === "--book" || v === "-b") a.bookId = argv[++i] ?? null;
    else if (v === "--all") a.all = true;
    else if (v === "--dry-run" || v === "-n") a.dryRun = true;
    else if (v === "--help" || v === "-h") {
      console.log(
        "Usage: rescan-pdf [--book <uuid> | --all] [--dry-run]\n",
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

function normalizeWhitespace(text: string): string {
  return text
    .replace(/-\s*\n\s*/g, "")
    .replace(/[\s ]+/g, " ")
    .trim();
}

function segmentSentences(
  perPageText: { page: number; text: string }[],
): { idx: number; page: number; text: string }[] {
  const out: { idx: number; page: number; text: string }[] = [];
  let idx = 0;
  for (const { page, text } of perPageText) {
    const normalized = normalizeWhitespace(text);
    if (!normalized) continue;
    const parts = normalized.split(SENTENCE_SPLIT);
    for (const part of parts) {
      const t = part.trim();
      if (t.length < MIN_SENTENCE_LEN || t.length > MAX_SENTENCE_LEN) continue;
      out.push({ idx, page, text: t });
      idx++;
    }
  }
  return out;
}

function dbPathToHostPath(filePath: string): string {
  // DB rows store the container path "/data/books/<userId>/<bookId>.pdf".
  // The host volume is /var/lib/tts-raizhost/books. Translate by replacing
  // the leading "/data/books" prefix.
  if (filePath.startsWith("/data/books/")) {
    return filePath.replace(/^\/data\/books/, BOOKS_HOST_DIR);
  }
  return filePath;
}

async function rescanBook(bookId: string, dryRun: boolean): Promise<{
  bookTitle: string;
  pageCount: number;
  sentenceCount: number;
  oldSentenceCount: number;
  preview: string[];
}> {
  const db = getDb();

  const bookRows = await db
    .select({
      id: schema.books.id,
      title: schema.books.title,
      filePath: schema.books.filePath,
      sentenceCount: schema.books.sentenceCount,
    })
    .from(schema.books)
    .where(eq(schema.books.id, bookId))
    .limit(1);

  if (bookRows.length === 0) {
    throw new Error(`book ${bookId} not found`);
  }
  const book = bookRows[0];
  const hostPath = dbPathToHostPath(book.filePath);
  const buf = await fs.readFile(hostPath);

  // Load pdfjs-dist in node. The legacy build runs without a worker when
  // we explicitly disable it.
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");

  const data = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  // In node, pdfjs runs without a worker if you don't set GlobalWorkerOptions.workerSrc.
  const doc = await pdfjs.getDocument({
    data,
    isEvalSupported: false,
    useSystemFonts: true,
  }).promise;

  const pageCount = doc.numPages;
  const perPageText: { page: number; text: string }[] = [];

  for (let pageNum = 1; pageNum <= pageCount; pageNum++) {
    const page = await doc.getPage(pageNum);
    const content = await page.getTextContent({
      disableNormalization: false,
      includeMarkedContent: false,
    });
    const flowed = flowTextItems(content.items as ReadonlyArray<RawTextItem>);
    const text = reflowSpacedGlyphs(flowed);
    perPageText.push({ page: pageNum, text });
    page.cleanup();
  }
  await doc.destroy();

  const sentences = segmentSentences(perPageText);
  const preview = sentences
    .slice(0, 5)
    .map((s) => `idx=${s.idx} page=${s.page} ${JSON.stringify(s.text.slice(0, 140))}`);

  if (!dryRun) {
    await db.transaction(async (tx) => {
      await tx
        .delete(schema.bookSentences)
        .where(eq(schema.bookSentences.bookId, bookId));

      const CHUNK = 500;
      for (let i = 0; i < sentences.length; i += CHUNK) {
        const chunk = sentences.slice(i, i + CHUNK).map((s) => ({
          bookId,
          idx: s.idx,
          page: s.page,
          text: s.text,
        }));
        await tx.insert(schema.bookSentences).values(chunk);
      }
      await tx
        .update(schema.books)
        .set({
          pageCount,
          sentenceCount: sentences.length,
        })
        .where(eq(schema.books.id, bookId));
    });
  }

  return {
    bookTitle: book.title,
    pageCount,
    sentenceCount: sentences.length,
    oldSentenceCount: book.sentenceCount,
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

  for (const id of ids) {
    console.log(`\n=== rescanning ${id} ${args.dryRun ? "(DRY RUN)" : ""} ===`);
    try {
      const r = await rescanBook(id, args.dryRun);
      console.log(`  title:           ${r.bookTitle}`);
      console.log(`  pages:           ${r.pageCount}`);
      console.log(`  sentences:       ${r.oldSentenceCount} -> ${r.sentenceCount}`);
      console.log(`  preview:`);
      for (const p of r.preview) console.log(`    ${p}`);
    } catch (err) {
      console.error(`  FAILED:`, err instanceof Error ? err.message : err);
    }
  }

  process.exit(0);
}

main().catch((err) => {
  console.error("rescan-pdf failed:", err);
  process.exit(1);
});
