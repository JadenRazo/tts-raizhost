// Re-clean sentence rows that were imported before the text-cleanup
// pipeline shipped. For each book, we read the existing rows in idx
// order, run the same pipeline the upload form runs (cleanSentenceText
// per row, isUnlistenable drop filter, mergeAbbreviationSplits over the
// ordered set, re-index), then atomically replace the rows and update
// the books.sentence_count column.
//
// Reading positions that point past the new (smaller) sentence count
// are clamped to the last valid idx so a user's saved spot lands on the
// new final sentence rather than disappearing.
//
// The TTS audio cache (tts_cache) is keyed by sha256(voice|speed|text),
// so cleaned-up sentences will produce new cache keys on first play.
// Old entries become orphaned and will age out via the existing LRU.
// We don't proactively delete them — they're cheap and harmless.
//
// Idempotent: running twice on the same data is a no-op (the cleanup
// pipeline is itself idempotent, and the row count won't drop further
// once everything is already clean).
//
// Usage:
//   npm run cleanup-existing-sentences -- --dry-run   # report changes only
//   npm run cleanup-existing-sentences                # apply changes
//   npm run cleanup-existing-sentences -- --book <uuid>   # one book

import { and, asc, eq, gte } from "drizzle-orm";

import { getDb, schema } from "../src/lib/db";
import {
  cleanSentenceText,
  isUnlistenable,
  mergeAbbreviationSplits,
} from "../src/lib/text-cleanup";

type Args = {
  dryRun: boolean;
  bookId: string | null;
};

function parseArgs(argv: string[]): Args {
  const args: Args = { dryRun: false, bookId: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") args.dryRun = true;
    else if (a === "--book") args.bookId = argv[++i] ?? null;
  }
  return args;
}

type Outcome = {
  bookId: string;
  title: string;
  before: number;
  after: number;
  dropped: number;
  merged: number;
  modified: number;
  positionsClamped: number;
};

async function cleanOneBook(
  db: ReturnType<typeof getDb>,
  bookId: string,
  title: string,
  dryRun: boolean,
): Promise<Outcome> {
  const rows = await db
    .select({
      idx: schema.bookSentences.idx,
      page: schema.bookSentences.page,
      text: schema.bookSentences.text,
    })
    .from(schema.bookSentences)
    .where(eq(schema.bookSentences.bookId, bookId))
    .orderBy(asc(schema.bookSentences.idx));

  const before = rows.length;
  if (before === 0) {
    return { bookId, title, before: 0, after: 0, dropped: 0, merged: 0, modified: 0, positionsClamped: 0 };
  }

  // Stage 1: clean text in place. Track how many texts changed so we can
  // report it; that count includes both pure rewrites (underscore strip,
  // footnote markers stripped) and rows whose content was empty after
  // cleanup and will be dropped in stage 2.
  let modified = 0;
  const cleaned: { page: number; origIdx: number; text: string }[] = [];
  for (const row of rows) {
    const cleanedText = cleanSentenceText(row.text);
    if (cleanedText !== row.text) modified++;
    if (cleanedText.length === 0) continue;
    cleaned.push({ page: row.page, origIdx: row.idx, text: cleanedText });
  }

  // Stage 2: drop unlistenable rows using positional context derived from
  // the post-clean count. Positional drops (boilerplate at edges, index
  // entries near the end) need this context; standalone-glyph drops do
  // not but get evaluated together for simplicity.
  const dropTotal = cleaned.length;
  const surviving: { page: number; text: string }[] = [];
  let dropped = 0;
  for (let i = 0; i < cleaned.length; i++) {
    if (isUnlistenable(cleaned[i].text, { idx: i, total: dropTotal })) {
      dropped++;
      continue;
    }
    surviving.push({ page: cleaned[i].page, text: cleaned[i].text });
  }

  // Stage 3: merge abbreviation false-splits and re-index.
  const indexed = surviving.map((s, i) => ({ idx: i, page: s.page, text: s.text }));
  const merged = mergeAbbreviationSplits(indexed);
  const mergedCount = indexed.length - merged.length;
  const after = merged.length;

  // Reading positions that point past the new last index need clamping.
  // We pre-count for the dry-run report, then apply in the transaction.
  const positions = await db
    .select({
      userId: schema.readingPositions.userId,
      sentenceIdx: schema.readingPositions.sentenceIdx,
    })
    .from(schema.readingPositions)
    .where(
      and(
        eq(schema.readingPositions.bookId, bookId),
        gte(schema.readingPositions.sentenceIdx, after),
      ),
    );
  const positionsClamped = positions.length;

  if (dryRun) {
    return { bookId, title, before, after, dropped, merged: mergedCount, modified, positionsClamped };
  }

  if (before === after && modified === 0 && dropped === 0 && mergedCount === 0) {
    return { bookId, title, before, after, dropped, merged: mergedCount, modified, positionsClamped };
  }

  // Atomic replacement. Insert the new rows under fresh idx values, then
  // delete the old rows whose idx lands past the new top, then update
  // the rest in place. Doing it as DELETE-then-INSERT under a single
  // transaction is simpler and the rows are small enough that the lock
  // window is negligible.
  await db.transaction(async (tx) => {
    await tx
      .delete(schema.bookSentences)
      .where(eq(schema.bookSentences.bookId, bookId));

    if (merged.length > 0) {
      // Drizzle's batch insert is unbounded but Postgres caps query size.
      // 500-row chunks match the live insert route's MAX_PER_REQUEST.
      const CHUNK = 500;
      for (let i = 0; i < merged.length; i += CHUNK) {
        const slice = merged.slice(i, i + CHUNK);
        await tx.insert(schema.bookSentences).values(
          slice.map((s) => ({
            bookId,
            idx: s.idx,
            page: s.page,
            text: s.text,
          })),
        );
      }
    }

    await tx
      .update(schema.books)
      .set({ sentenceCount: after })
      .where(eq(schema.books.id, bookId));

    if (positionsClamped > 0) {
      const lastIdx = Math.max(0, after - 1);
      await tx
        .update(schema.readingPositions)
        .set({ sentenceIdx: lastIdx, charOffset: 0 })
        .where(
          and(
            eq(schema.readingPositions.bookId, bookId),
            gte(schema.readingPositions.sentenceIdx, after),
          ),
        );
    }
  });

  return { bookId, title, before, after, dropped, merged: mergedCount, modified, positionsClamped };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const db = getDb();

  const targets = await db
    .select({ id: schema.books.id, title: schema.books.title })
    .from(schema.books)
    .where(args.bookId ? eq(schema.books.id, args.bookId) : undefined)
    .orderBy(asc(schema.books.uploadedAt));

  if (targets.length === 0) {
    console.log("no books matched");
    process.exit(0);
  }

  console.log(
    `${args.dryRun ? "[dry-run] " : ""}cleaning ${targets.length} book(s)`,
  );
  console.log("");

  const results: Outcome[] = [];
  for (const b of targets) {
    const out = await cleanOneBook(db, b.id, b.title, args.dryRun);
    results.push(out);
    const delta = out.before - out.after;
    console.log(
      `${out.bookId.slice(0, 8)}  ${out.title.padEnd(50).slice(0, 50)}  ` +
        `${String(out.before).padStart(5)} → ${String(out.after).padStart(5)}  ` +
        `(-${String(delta).padStart(4)})  ` +
        `dropped=${out.dropped} merged=${out.merged} modified=${out.modified} ` +
        `positions=${out.positionsClamped}`,
    );
  }

  const totals = results.reduce(
    (acc, r) => ({
      before: acc.before + r.before,
      after: acc.after + r.after,
      dropped: acc.dropped + r.dropped,
      merged: acc.merged + r.merged,
      modified: acc.modified + r.modified,
      positionsClamped: acc.positionsClamped + r.positionsClamped,
    }),
    { before: 0, after: 0, dropped: 0, merged: 0, modified: 0, positionsClamped: 0 },
  );
  console.log("");
  console.log(
    `TOTAL  ${totals.before} → ${totals.after}  (-${totals.before - totals.after})  ` +
      `dropped=${totals.dropped} merged=${totals.merged} ` +
      `modified=${totals.modified} positions=${totals.positionsClamped}`,
  );
  if (args.dryRun) {
    console.log("(dry-run; no changes written)");
  }
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
