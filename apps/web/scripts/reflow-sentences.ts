// One-shot backfill: rewrite every existing book_sentences.text through
// reflowSpacedGlyphs so previously-uploaded books with the "N i n e
// s u g g e s t i o n s" pathology come out clean without re-uploading.
//
// Idempotent — re-running is safe and a no-op once everything is clean.
// Audio cache rows for changed sentences get a different cacheKey on the
// next play (sha256(voice|speed|text)) and the orphans evict via the
// existing nightly LRU CronJob.
//
// Usage:
//   npm --prefix apps/web exec tsx scripts/reflow-sentences.ts
//   npm --prefix apps/web exec tsx scripts/reflow-sentences.ts --dry-run

import { and, asc, eq, gt, or, type SQL } from "drizzle-orm";

import { getDb } from "../src/lib/db";
import * as schema from "../src/lib/db/schema";
import { reflowSpacedGlyphs } from "../src/lib/text-reflow";

const PAGE_SIZE = 1000;

type Args = { dryRun: boolean };

function parseArgs(argv: string[]): Args {
  const args: Args = { dryRun: false };
  for (const a of argv) {
    if (a === "--dry-run" || a === "-n") args.dryRun = true;
    if (a === "--help" || a === "-h") {
      console.log("Usage: reflow-sentences [--dry-run]");
      process.exit(0);
    }
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const db = getDb();

  let cursorBookId: string | null = null;
  let cursorIdx = -1;
  let totalRows = 0;
  let totalChanged = 0;
  const perBook = new Map<string, { total: number; changed: number }>();

  while (true) {
    const where: SQL | undefined =
      cursorBookId === null
        ? undefined
        : or(
            gt(schema.bookSentences.bookId, cursorBookId),
            and(
              eq(schema.bookSentences.bookId, cursorBookId),
              gt(schema.bookSentences.idx, cursorIdx),
            ),
          );

    const rows: { bookId: string; idx: number; text: string }[] = await db
      .select({
        bookId: schema.bookSentences.bookId,
        idx: schema.bookSentences.idx,
        text: schema.bookSentences.text,
      })
      .from(schema.bookSentences)
      .where(where)
      .orderBy(asc(schema.bookSentences.bookId), asc(schema.bookSentences.idx))
      .limit(PAGE_SIZE);

    if (rows.length === 0) break;

    for (const row of rows) {
      totalRows++;
      const cleaned = reflowSpacedGlyphs(row.text);
      const stats = perBook.get(row.bookId) ?? { total: 0, changed: 0 };
      stats.total++;
      perBook.set(row.bookId, stats);

      if (cleaned !== row.text) {
        stats.changed++;
        totalChanged++;
        if (!args.dryRun) {
          await db
            .update(schema.bookSentences)
            .set({ text: cleaned })
            .where(
              and(
                eq(schema.bookSentences.bookId, row.bookId),
                eq(schema.bookSentences.idx, row.idx),
              ),
            );
        }
      }
    }

    const last: { bookId: string; idx: number } = rows[rows.length - 1];
    cursorBookId = last.bookId;
    cursorIdx = last.idx;
  }

  console.log("");
  console.log(args.dryRun ? "DRY RUN — no rows written." : "backfill complete.");
  console.log(`  scanned: ${totalRows}`);
  console.log(`  changed: ${totalChanged}`);
  console.log("");
  for (const [bookId, stats] of perBook) {
    if (stats.changed === 0) continue;
    console.log(`  ${bookId}  changed=${stats.changed}/${stats.total}`);
  }

  process.exit(0);
}

main().catch((err) => {
  console.error("reflow-sentences failed:", err);
  process.exit(1);
});
