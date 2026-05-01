// Seeds the curated public-domain library shown in the Featured section
// of every signed-in user's home page.
//
// Source: Project Gutenberg plain-text endpoint
//   https://www.gutenberg.org/cache/epub/<id>/pg<id>.txt
// Plain text is more reliable than PG's PDF generator (most works no
// longer have an auto-generated PDF), and we skip pdfjs entirely since
// the text is already extracted. PG's standard START/END markers are
// stripped before sentence segmentation; the byte stream that lands on
// disk is the cleaned text, not the wrapped PG file.
//
// Each book is owned by a fixed system user UUID so the existing
// books.user_id FK constraint holds. Public books are excluded from
// per-user storage caps and from the Delete affordance — see
// LibraryView and userCanReadBook in @/lib/books.
//
// Idempotent: a book whose normalized text sha256 already exists in
// the books table is skipped on re-run, matching the same uniqueness
// signal user uploads use.
//
// Usage:
//   npm run seed-public-books
//   npm run seed-public-books -- --dry-run
//   npm run seed-public-books -- --only walden

import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { eq } from "drizzle-orm";

import { getDb } from "../src/lib/db";
import * as schema from "../src/lib/db/schema";
import { cleanupSentencePipeline } from "../src/lib/text-cleanup";

// Fixed UUID owning every public book. Conforms to the UUID regex
// enforced by lib/storage:assertUuid so the file path helper accepts
// it. The script upserts a matching users row before any book insert.
const SYSTEM_USER_ID = "00000000-0000-4000-8000-000000000001";
const SYSTEM_USER_EMAIL = "library@system.tts.raizhost.local";

const BOOKS_HOST_DIR =
  process.env.BOOKS_HOST_DIR ?? "/var/lib/tts-raizhost/books";
const CONTAINER_BOOKS_PREFIX = "/data/books";

const FETCH_TIMEOUT_MS = 60_000;
const SENTENCE_INSERT_CHUNK = 500;

// PG sometimes throttles bare fetches with a default UA — match the
// convention real clients use.
const FETCH_UA = "Mozilla/5.0 (compatible; library-seeder)";

// Char-count heuristic for synthesizing a page index without a real PDF.
// Roughly matches a print page; not user-visible beyond the "N pages"
// summary in the library row.
const APPROX_CHARS_PER_PAGE = 2500;

// Mirrors apps/web/src/app/upload/upload-form.tsx so seeded books and
// user uploads produce comparable sentence boundaries.
const SENTENCE_SPLIT = /(?<=[.!?])\s+(?=[A-Z"“«(])/;
// Stricter than the upload form's 3-char floor — title-page fragments
// in PG plaintext ("OF.", "BY.", "BOOK I.") cleanly fail the multi-word
// requirement here without affecting real prose.
const MIN_SENTENCE_LEN = 12;
const MIN_SENTENCE_WORDS = 3;
const MAX_SENTENCE_LEN = 1500;

type SeedBook = {
  slug: string;
  title: string;
  author: string;
  gutenbergId: number;
  /** Manual override for books where heuristics can't reliably find the
   * body. If set, the first occurrence of this string in the cleaned
   * text marks the start of the book. Useful for PG files that bundle
   * multiple works (e.g. The Prince + Life of Castruccio in #1232). */
  proseStart?: string;
};

const BOOKS: SeedBook[] = [
  {
    slug: "science-of-getting-rich",
    title: "The Science of Getting Rich",
    author: "Wallace D. Wattles",
    gutenbergId: 59844,
  },
  {
    slug: "autobiography-of-benjamin-franklin",
    title: "The Autobiography of Benjamin Franklin",
    author: "Benjamin Franklin",
    gutenbergId: 20203,
  },
  {
    slug: "as-a-man-thinketh",
    title: "As a Man Thinketh",
    author: "James Allen",
    gutenbergId: 4507,
  },
  {
    slug: "self-help",
    title: "Self-Help",
    author: "Samuel Smiles",
    gutenbergId: 935,
  },
  {
    slug: "meditations",
    title: "Meditations",
    author: "Marcus Aurelius",
    gutenbergId: 2680,
  },
  {
    slug: "art-of-war",
    title: "The Art of War",
    author: "Sun Tzu",
    gutenbergId: 132,
  },
  {
    slug: "the-prince",
    title: "The Prince",
    author: "Niccolò Machiavelli",
    gutenbergId: 1232,
    // PG #1232 bundles The Prince with The Life of Castruccio; the
    // actual book starts at the Dedication.
    proseStart: "Magnificent Lorenzo",
  },
  {
    slug: "walden",
    title: "Walden",
    author: "Henry David Thoreau",
    gutenbergId: 205,
  },
];

type Args = { dryRun: boolean; only: string | null };

function parseArgs(argv: string[]): Args {
  const a: Args = { dryRun: false, only: null };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    if (v === "--dry-run" || v === "-n") a.dryRun = true;
    else if (v === "--only") a.only = argv[++i] ?? null;
    else if (v === "--help" || v === "-h") {
      console.log("Usage: seed-public-books [--dry-run] [--only <slug>]");
      process.exit(0);
    }
  }
  return a;
}

async function fetchTextOnce(url: string): Promise<string | null> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      redirect: "follow",
      signal: ac.signal,
      headers: {
        "User-Agent": FETCH_UA,
        Accept: "text/plain,*/*;q=0.5",
      },
    });
    if (!res.ok) return null;
    const text = await res.text();
    return text.length > 1024 ? text : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// PG rate-limits rapid sequential bursts to a single host. One retry
// after a short backoff catches the common case where the first try
// hit a throttled edge node.
async function fetchText(url: string): Promise<string | null> {
  const first = await fetchTextOnce(url);
  if (first) return first;
  await new Promise((r) => setTimeout(r, 4000));
  return fetchTextOnce(url);
}

// Strip PG's wrapping header and license footer. The markers vary
// slightly across decades of uploads, so we accept a few forms.
function stripGutenbergWrapper(raw: string): string {
  const startRe = /^[*]{3}\s*START OF (?:THE|THIS)\s+PROJECT GUTENBERG.+$/m;
  const endRe = /^[*]{3}\s*END OF (?:THE|THIS)\s+PROJECT GUTENBERG.+$/m;
  let body = raw;
  const startMatch = body.match(startRe);
  if (startMatch && startMatch.index !== undefined) {
    body = body.slice(startMatch.index + startMatch[0].length);
  }
  const endMatch = body.match(endRe);
  if (endMatch && endMatch.index !== undefined) {
    body = body.slice(0, endMatch.index);
  }
  return body.trim();
}

// Manual override path: slice the stripped body at the first
// case-insensitive occurrence of `marker`. Used for PG files where
// heuristics can't pick the right starting point (multi-work bundles,
// long biographical introductions that pre-date the actual book).
function sliceFromMarker(body: string, marker: string): string {
  const lower = body.toLowerCase();
  const i = lower.indexOf(marker.toLowerCase());
  if (i < 0) return body;
  return body.slice(i);
}

// PG files put front-matter (transcriber credits, title page, TOC,
// PG-inserted prefaces, and sometimes anecdote-style illustration
// captions) between the START marker and the actual prose. We skip
// past it by finding the first paragraph that's clearly body prose:
//
//   - Long enough overall (>= 400 chars).
//   - Enough sentence terminators (>= 5).
//   - At least one long sentence (>= 80 chars). TOC entries are short.
//   - Not entirely wrapped in quotes (epigraph/caption heuristic).
//   - Not a "TABLE OF CONTENTS" / "CONTENTS" header block.
//   - Doesn't reference Project Gutenberg (PG-inserted prefaces).
function dropFrontMatter(body: string): string {
  const paragraphs = body.split(/\n\s*\n+/);
  for (let i = 0; i < paragraphs.length; i++) {
    const p = paragraphs[i].trim();
    if (p.length < 400) continue;
    const terminators = (p.match(/[.!?]/g) ?? []).length;
    if (terminators < 5) continue;
    if (/^["“]/.test(p) && /["”]\s*$/.test(p)) continue;
    if (/\b(?:TABLE OF CONTENTS|CONTENTS)\b/.test(p) && terminators < 10) continue;
    if (/Project Gutenberg/i.test(p)) continue;
    const sentences = p.split(/[.!?]\s+/);
    const hasLongSentence = sentences.some((s) => s.length >= 80);
    if (!hasLongSentence) continue;
    return paragraphs.slice(i).join("\n\n");
  }
  return body;
}

// Inline cleanup of common PG plain-text artifacts: image markers
// dropped entirely, italic underscores stripped, soft-hyphenated line
// breaks rejoined. Done before paragraph-aware reflow so paragraph
// boundaries stay intact.
function stripInlineArtifacts(text: string): string {
  return text
    .replace(/\r\n/g, "\n")
    .replace(/\[\s*(?:Illustration|Picture|Image|Footnote)[^\]]*\]/gi, "")
    .replace(/(^|[\s(])_([^_\n]{1,200})_($|[\s.,;:!?)])/g, "$1$2$3")
    .replace(/-\s*\n\s*/g, "");
}

// Convert raw text into a single line ready for sentence segmentation.
// Paragraph breaks (\n\n+) become hard sentence boundaries — without
// this, chapter titles and TOC entries (which often lack a terminator)
// get glued onto the next sentence and produce 500-char mega-blobs.
function reflowToOneLine(text: string): string {
  return text
    .replace(/([^.!?])\n\s*\n+/g, "$1. ")
    .replace(/\n\s*\n+/g, " ")
    .replace(/\n+/g, " ")
    .replace(/[\s ]+/g, " ")
    .trim();
}

function normalizeWhitespace(text: string): string {
  return reflowToOneLine(stripInlineArtifacts(text));
}

function sha256Hex(text: string): string {
  return crypto.createHash("sha256").update(text, "utf8").digest("hex");
}

// Detects predominantly-uppercase short fragments that PG plaintext
// uses for chapter and section headings. The 85% letter-uppercase
// threshold preserves real prose that opens with a name in caps
// (e.g. "MARCUS AURELIUS ANTONINUS was born...") because the rest of
// the sentence brings the ratio down.
function isLikelyHeading(t: string): boolean {
  if (t.length > 200) return false;
  const letters = t.replace(/[^A-Za-z]/g, "");
  if (letters.length === 0) return false;
  const upper = letters.replace(/[^A-Z]/g, "").length;
  return upper / letters.length > 0.85;
}

function segmentSentences(
  cleanText: string,
): { idx: number; page: number; text: string }[] {
  const draft: { page: number; text: string }[] = [];
  if (!cleanText) return [];
  const parts = cleanText.split(SENTENCE_SPLIT);
  let charsSoFar = 0;
  for (const part of parts) {
    const t = part.trim();
    if (t.length < MIN_SENTENCE_LEN || t.length > MAX_SENTENCE_LEN) continue;
    const wordCount = t.split(/\s+/).length;
    if (wordCount < MIN_SENTENCE_WORDS) continue;
    if (isLikelyHeading(t)) continue;
    const page = Math.max(1, Math.floor(charsSoFar / APPROX_CHARS_PER_PAGE) + 1);
    draft.push({ page, text: t });
    charsSoFar += t.length + 1;
  }
  // Hand off to the canonical cleanup pipeline used by uploads and the
  // backfill script. This is what title-cases shouty name openers
  // ("MARCUS AURELIUS ANTONINUS was born…" → "Marcus Aurelius Antoninus
  // was born…"), strips Project-Gutenberg italic underscores, drops
  // boilerplate, and merges abbreviation false-splits — the same rules
  // user-uploaded PDFs get.
  return cleanupSentencePipeline(draft);
}

async function ensureSystemUser(): Promise<void> {
  const db = getDb();
  await db
    .insert(schema.users)
    .values({
      id: SYSTEM_USER_ID,
      email: SYSTEM_USER_EMAIL,
      emailVerified: false,
      name: "Featured Library",
      isAdmin: false,
    })
    .onConflictDoNothing();
}

async function bookAlreadyIngested(textSha256: string): Promise<boolean> {
  const db = getDb();
  const existing = await db
    .select({ id: schema.books.id })
    .from(schema.books)
    .where(eq(schema.books.textSha256, textSha256))
    .limit(1);
  return existing.length > 0;
}

async function writeTextToDisk(
  bookId: string,
  text: string,
): Promise<{ hostPath: string; bytes: number }> {
  const dir = path.join(BOOKS_HOST_DIR, SYSTEM_USER_ID);
  // Keep the .pdf extension to match the existing storage convention —
  // the file is rarely served (the reader works off book_sentences) and
  // keeping a single extension simplifies the disk-cleanup tooling.
  const finalPath = path.join(dir, `${bookId}.pdf`);
  await fs.mkdir(dir, { recursive: true });
  const tmpPath = `${finalPath}.tmp`;
  try {
    await fs.writeFile(tmpPath, text, "utf8");
    await fs.rename(tmpPath, finalPath);
  } catch (err) {
    await fs.unlink(tmpPath).catch(() => undefined);
    throw err;
  }
  const stat = await fs.stat(finalPath);
  return { hostPath: finalPath, bytes: stat.size };
}

async function ingestBook(book: SeedBook, dryRun: boolean): Promise<{
  status: "ok" | "skipped" | "no-text" | "no-sentences";
  bookId?: string;
  pageCount?: number;
  sentenceCount?: number;
  notes?: string;
}> {
  const url = `https://www.gutenberg.org/cache/epub/${book.gutenbergId}/pg${book.gutenbergId}.txt`;
  const raw = await fetchText(url);
  if (!raw) return { status: "no-text", notes: `fetch failed: ${url}` };

  const stripped = stripGutenbergWrapper(raw);
  const body = book.proseStart
    ? sliceFromMarker(stripped, book.proseStart)
    : dropFrontMatter(stripped);
  const normalized = normalizeWhitespace(body);
  if (normalized.length < 1000) {
    return { status: "no-text", notes: `body too short after strip (${normalized.length} chars)` };
  }

  const textSha256 = sha256Hex(normalized);
  if (await bookAlreadyIngested(textSha256)) {
    return {
      status: "skipped",
      notes: `already ingested (sha ${textSha256.slice(0, 12)})`,
    };
  }

  const sentences = segmentSentences(normalized);
  if (sentences.length === 0) {
    return { status: "no-sentences", notes: "segmentation produced 0 sentences" };
  }
  const pageCount = Math.max(
    1,
    Math.ceil(normalized.length / APPROX_CHARS_PER_PAGE),
  );

  if (dryRun) {
    return {
      status: "ok",
      bookId: "(dry-run)",
      pageCount,
      sentenceCount: sentences.length,
    };
  }

  const bookId = crypto.randomUUID();
  const { bytes } = await writeTextToDisk(bookId, stripped);

  // DB filePath uses the container prefix so the row is portable
  // across dev (host paths) and prod (container paths).
  const containerPath = `${CONTAINER_BOOKS_PREFIX}/${SYSTEM_USER_ID}/${bookId}.pdf`;

  const db = getDb();
  await db.transaction(async (tx) => {
    await tx.insert(schema.books).values({
      id: bookId,
      userId: SYSTEM_USER_ID,
      title: book.title,
      author: book.author,
      originalFilename: `${book.slug}.txt`,
      filePath: containerPath,
      byteSize: bytes,
      pageCount,
      sentenceCount: sentences.length,
      textSha256,
      isPublic: true,
    });
    for (let i = 0; i < sentences.length; i += SENTENCE_INSERT_CHUNK) {
      const chunk = sentences
        .slice(i, i + SENTENCE_INSERT_CHUNK)
        .map((s) => ({ bookId, idx: s.idx, page: s.page, text: s.text }));
      await tx.insert(schema.bookSentences).values(chunk);
    }
  });

  return {
    status: "ok",
    bookId,
    pageCount,
    sentenceCount: sentences.length,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const targets = args.only
    ? BOOKS.filter((b) => b.slug === args.only)
    : BOOKS;
  if (args.only && targets.length === 0) {
    console.error(`error: no book with slug "${args.only}"`);
    console.error(`known slugs: ${BOOKS.map((b) => b.slug).join(", ")}`);
    process.exit(1);
  }

  if (!args.dryRun) {
    await ensureSystemUser();
  }

  const summary: Record<string, number> = {
    ok: 0,
    skipped: 0,
    "no-text": 0,
    "no-sentences": 0,
    error: 0,
  };
  for (let i = 0; i < targets.length; i++) {
    const book = targets[i];
    if (i > 0) await new Promise((r) => setTimeout(r, 1500));
    console.log(
      `\n=== ${book.slug}: ${book.title} (PG #${book.gutenbergId}) ===`,
    );
    try {
      const r = await ingestBook(book, args.dryRun);
      summary[r.status]++;
      if (r.status === "ok") {
        console.log(
          `  ingested${args.dryRun ? " (dry run)" : ""}: ${r.pageCount} pages, ${r.sentenceCount} sentences`,
        );
        if (r.bookId) console.log(`  bookId: ${r.bookId}`);
      } else {
        console.log(`  ${r.status}${r.notes ? ` — ${r.notes}` : ""}`);
      }
    } catch (err) {
      summary.error++;
      console.error(
        `  FAILED: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  console.log(
    `\nsummary: ok=${summary.ok} skipped=${summary.skipped} no-text=${summary["no-text"]} no-sentences=${summary["no-sentences"]} error=${summary.error}`,
  );
  process.exit(0);
}

main().catch((err) => {
  console.error("seed-public-books failed:", err);
  process.exit(1);
});
