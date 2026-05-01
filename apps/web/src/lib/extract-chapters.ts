// PDF outline → reader chapters.
//
// Walks pdfjs-dist's outline tree, resolves each entry's destination
// to a 1-based page number via `getDestination` + `getPageIndex`,
// then maps that page to the first sentence-idx on or after it.
// Empty titles, external URLs, and unresolvable dests are skipped;
// adjacent entries that resolve to the same idx are deduped (TOCs
// occasionally do that for chapter-with-subtitle pairs).
//
// Used by:
//   - upload-form.tsx, where the same browser pdfjs that just parsed
//     the file's text also walks its outline.
//   - reader.tsx, when a previously-uploaded book has zero chapters
//     and we want to backfill from the browser (server-side pdfjs
//     fails on a meaningful subset of real-world PDFs that the
//     browser parses without trouble — Indexing-all-PDF-objects
//     recovery + Invalid PDF structure).

import type { PDFDocumentProxy } from "pdfjs-dist";

export type ExtractedChapter = {
  title: string;
  startSentenceIdx: number;
  depth: number;
  ord: number;
};

export async function extractChaptersFromPdf(
  doc: PDFDocumentProxy,
  sentences: { idx: number; page: number }[],
): Promise<ExtractedChapter[]> {
  let outline:
    | Awaited<ReturnType<typeof doc.getOutline>>
    | null = null;
  try {
    outline = await doc.getOutline();
  } catch {
    return [];
  }
  if (!outline || outline.length === 0) return [];

  // Build page → first-sentence-idx index in one pass. Sentences are
  // expected to be in idx order, so the first row encountered for
  // each page is its first sentence.
  const firstIdxByPage = new Map<number, number>();
  for (const s of sentences) {
    if (!firstIdxByPage.has(s.page)) firstIdxByPage.set(s.page, s.idx);
  }
  const knownPages = [...firstIdxByPage.keys()].sort((a, b) => a - b);
  function firstIdxAtOrAfter(page: number): number | null {
    for (const p of knownPages) {
      if (p >= page) return firstIdxByPage.get(p) ?? null;
    }
    return null;
  }

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
        typeof pageRef === "number" ? pageRef : await doc.getPageIndex(pageRef);
      return pageIndex + 1; // 1-based to match book_sentences.page
    } catch {
      return null;
    }
  }

  const chapters: ExtractedChapter[] = [];
  let ord = 0;

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
  return chapters;
}
