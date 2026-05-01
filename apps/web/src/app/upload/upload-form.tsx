"use client";

// Client-side PDF parse + upload.
//
// pdfjs-dist worker: we self-host the worker from public/ rather than
// pulling from a CDN. Self-hosting matches the package version exactly,
// keeps a CDN compromise from silently exfiltrating uploaded PDFs (the
// worker sees the bytes pre-upload), and avoids a third-party connect-
// src in our CSP. The file is re-copied from node_modules on every
// build via scripts/copy-pdfjs-worker.mjs (prebuild + predev hooks).

import { useCallback, useRef, useState, type ChangeEvent, type DragEvent } from "react";
import { useRouter } from "next/navigation";

import {
  type ExtractedChapter,
  extractChaptersFromPdf,
} from "@/lib/extract-chapters";
import { rum } from "@/lib/rum";
import { cleanupSentencePipeline } from "@/lib/text-cleanup";
import { flowTextItems, reflowSpacedGlyphs, type RawTextItem } from "@/lib/text-reflow";

const WORKER_SRC = "/pdf.worker.min.mjs";

const SENTENCE_SPLIT = /(?<=[.!?])\s+(?=[A-Z"“«(])/;
const MIN_SENTENCE_LEN = 3;
const MAX_SENTENCE_LEN = 1500;
const SENTENCE_CHUNK_SIZE = 500;

type Stage =
  | { kind: "idle" }
  | { kind: "loading-pdf"; fileName: string }
  | { kind: "parsing-pages"; fileName: string; current: number; total: number }
  | { kind: "uploading-file"; fileName: string }
  | { kind: "uploading-sentences"; uploaded: number; total: number }
  | { kind: "redirecting" }
  | { kind: "error"; message: string };

type ParsedPdf = {
  pageCount: number;
  sentences: { idx: number; page: number; text: string }[];
  chapters: ExtractedChapter[];
  textSha256: string;
  title: string;
  author: string | null;
};

function normalizeWhitespace(text: string): string {
  // Collapse stray hyphenated line breaks, then any run of whitespace
  // (including non-breaking spaces) to a single space.
  return text
    .replace(/-\s*\n\s*/g, "")
    .replace(/[\s ]+/g, " ")
    .trim();
}

function segmentSentences(
  perPageText: { page: number; text: string }[],
): { idx: number; page: number; text: string }[] {
  // Stage 1: naive period/exclam/question split. Produces over-fragmented
  // output (Mr.|Walters said... is two rows here), which the cleanup
  // pipeline then merges via mergeAbbreviationSplits.
  const raw: { page: number; text: string }[] = [];
  for (const { page, text } of perPageText) {
    const normalized = normalizeWhitespace(text);
    if (!normalized) continue;
    const parts = normalized.split(SENTENCE_SPLIT);
    for (const part of parts) {
      const t = part.trim();
      if (t.length < MIN_SENTENCE_LEN || t.length > MAX_SENTENCE_LEN) continue;
      raw.push({ page, text: t });
    }
  }

  // Stage 2: clean each sentence, drop unlistenable junk (TOC dot-leaders,
  // index entries, Roman-numeral chapter dividers, Project Gutenberg
  // boilerplate at edges), merge abbreviation false-splits, re-index.
  return cleanupSentencePipeline(raw);
}

async function sha256Hex(text: string): Promise<string> {
  const buf = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", buf);
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function parsePdf(
  file: File,
  onProgress: (current: number, total: number) => void,
): Promise<ParsedPdf> {
  // Dynamic import keeps pdfjs-dist out of the server bundle. The legacy
  // build is what works cleanly in browsers without ESM-isolation hooks.
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  pdfjs.GlobalWorkerOptions.workerSrc = WORKER_SRC;

  const data = new Uint8Array(await file.arrayBuffer());
  const doc = await pdfjs.getDocument({ data }).promise;

  const pageCount = doc.numPages;
  const perPageText: { page: number; text: string }[] = [];
  const fullChunks: string[] = [];

  for (let pageNum = 1; pageNum <= pageCount; pageNum++) {
    onProgress(pageNum, pageCount);
    const page = await doc.getPage(pageNum);
    const content = await page.getTextContent({
      disableNormalization: false,
      includeMarkedContent: false,
    });
    // Geometry-aware join + final spaced-glyph reflow. Layered defenses
    // for letter-tracked titles (the "N i n e" pathology) and embedded
    // invisibles. See lib/text-reflow.ts for details.
    const flowed = flowTextItems(content.items as ReadonlyArray<RawTextItem>);
    const text = reflowSpacedGlyphs(flowed);
    perPageText.push({ page: pageNum, text });
    fullChunks.push(text);
    page.cleanup();
  }

  const meta = await doc.getMetadata().catch(() => null);
  const info = (meta?.info ?? {}) as { Title?: string; Author?: string };

  const sentences = segmentSentences(perPageText);

  // Chapter extraction requires the doc to still be alive (getOutline +
  // getDestination + getPageIndex all hit doc internals), so do this
  // before destroy(). On any error, we end up with zero chapters and
  // the reader falls through to page-level navigation — never block
  // the upload on outline parsing.
  let chapters: ExtractedChapter[] = [];
  try {
    chapters = await extractChaptersFromPdf(doc, sentences);
  } catch (err) {
    console.warn("[upload] chapter extraction failed", err);
  }

  await doc.destroy();

  const normalizedFull = normalizeWhitespace(fullChunks.join(" "));
  const textSha256 = await sha256Hex(normalizedFull);

  const fallbackTitle = file.name.replace(/\.pdf$/i, "");
  const title = (info.Title ?? "").trim() || fallbackTitle;
  const author = (info.Author ?? "").trim() || null;

  return { pageCount, sentences, chapters, textSha256, title, author };
}

export function UploadForm({
  maxBytes,
  maxBooks,
}: {
  maxBytes: number;
  maxBooks: number;
}) {
  const router = useRouter();
  const [stage, setStage] = useState<Stage>({ kind: "idle" });
  const [file, setFile] = useState<File | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const maxMb = Math.round(maxBytes / 1024 / 1024);

  const validate = useCallback(
    (f: File): string | null => {
      const ext = f.name.toLowerCase().endsWith(".pdf");
      if (f.type && f.type !== "application/pdf" && !ext) {
        return "That doesn't look like a PDF.";
      }
      if (!f.type && !ext) {
        return "That doesn't look like a PDF.";
      }
      if (f.size === 0) return "File is empty.";
      if (f.size > maxBytes) {
        return `File is too large. Max ${maxMb} MB.`;
      }
      return null;
    },
    [maxBytes, maxMb],
  );

  function pickFile(f: File) {
    const err = validate(f);
    if (err) {
      setStage({ kind: "error", message: err });
      setFile(null);
      return;
    }
    setStage({ kind: "idle" });
    setFile(f);
  }

  function onFileChange(e: ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (f) pickFile(f);
  }

  function onDrop(e: DragEvent<HTMLLabelElement>) {
    e.preventDefault();
    setDragOver(false);
    const f = e.dataTransfer.files?.[0];
    if (f) pickFile(f);
  }

  async function onSubmit() {
    if (!file) return;

    try {
      setStage({ kind: "loading-pdf", fileName: file.name });

      const parsed = await parsePdf(file, (current, total) => {
        setStage({
          kind: "parsing-pages",
          fileName: file.name,
          current,
          total,
        });
      });

      if (parsed.sentences.length === 0) {
        setStage({
          kind: "error",
          message:
            "Couldn't extract any text from this PDF. Only text-extractable PDFs are supported (scanned/image-only PDFs won't work).",
        });
        return;
      }

      setStage({ kind: "uploading-file", fileName: file.name });
      const form = new FormData();
      form.append("file", file);
      form.append("title", parsed.title);
      if (parsed.author) form.append("author", parsed.author);
      form.append("pageCount", String(parsed.pageCount));
      form.append("sentenceCount", String(parsed.sentences.length));
      form.append("textSha256", parsed.textSha256);

      const createRes = await fetch("/api/books", {
        method: "POST",
        body: form,
      });
      if (!createRes.ok) {
        const body = (await createRes.json().catch(() => null)) as
          | { error?: string }
          | null;
        setStage({
          kind: "error",
          message: body?.error ?? `Upload failed (${createRes.status})`,
        });
        return;
      }
      const { id: bookId } = (await createRes.json()) as { id: string };

      // Stream sentences in chunks so a single huge POST can't time out the
      // proxy. The route is idempotent, so a retried chunk is safe.
      const total = parsed.sentences.length;
      let uploaded = 0;
      for (let i = 0; i < parsed.sentences.length; i += SENTENCE_CHUNK_SIZE) {
        const chunk = parsed.sentences.slice(i, i + SENTENCE_CHUNK_SIZE);
        const res = await fetch(`/api/books/${bookId}/sentences`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ sentences: chunk }),
        });
        if (!res.ok) {
          const body = (await res.json().catch(() => null)) as
            | { error?: string }
            | null;
          setStage({
            kind: "error",
            message:
              body?.error ?? `Sentence upload failed (${res.status})`,
          });
          return;
        }
        uploaded += chunk.length;
        setStage({ kind: "uploading-sentences", uploaded, total });
      }

      // Chapters are best-effort: a failure here doesn't fail the
      // upload — the reader's chapter actions just fall through to
      // page-level navigation.
      if (parsed.chapters.length > 0) {
        try {
          await fetch(`/api/books/${bookId}/chapters`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ chapters: parsed.chapters }),
          });
        } catch (err) {
          console.warn("[upload] chapter upload failed", err);
        }
      }

      rum.event("upload_succeeded", {
        page_count: parsed.pageCount,
        sentence_count: parsed.sentences.length,
        chapter_count: parsed.chapters.length,
      });
      setStage({ kind: "redirecting" });
      router.push("/");
      router.refresh();
    } catch (err) {
      console.error("[upload]", err);
      setStage({
        kind: "error",
        message:
          err instanceof Error
            ? `Couldn't read this PDF: ${err.message}`
            : "Something went wrong. Try again.",
      });
    }
  }

  function reset() {
    setStage({ kind: "idle" });
    setFile(null);
    if (inputRef.current) inputRef.current.value = "";
  }

  const busy =
    stage.kind === "loading-pdf" ||
    stage.kind === "parsing-pages" ||
    stage.kind === "uploading-file" ||
    stage.kind === "uploading-sentences" ||
    stage.kind === "redirecting";

  return (
    <div className="flex flex-col gap-4">
      <label
        htmlFor="pdf-input"
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={onDrop}
        className={`flex cursor-pointer flex-col items-center justify-center rounded-md border border-dashed px-6 py-12 text-center transition-colors ${
          dragOver
            ? "border-border-strong bg-surface-2"
            : "border-border bg-surface hover:border-border-strong"
        } ${busy ? "pointer-events-none opacity-60" : ""}`}
      >
        <span className="text-sm font-medium text-fg">
          {file ? file.name : "Pick a PDF or drag one here"}
        </span>
        <span className="mt-1 text-xs text-subtle">
          {file
            ? `${(file.size / 1024 / 1024).toFixed(1)} MB`
            : `Up to ${maxMb} MB`}
        </span>
        <input
          ref={inputRef}
          id="pdf-input"
          type="file"
          accept=".pdf,application/pdf"
          onChange={onFileChange}
          disabled={busy}
          className="sr-only"
        />
      </label>

      {stage.kind === "loading-pdf" ? (
        <p className="text-sm text-muted">Loading {stage.fileName}…</p>
      ) : null}

      {stage.kind === "parsing-pages" ? (
        <p className="text-sm text-muted">
          Parsing page {stage.current} of {stage.total}…
        </p>
      ) : null}

      {stage.kind === "uploading-file" ? (
        <p className="text-sm text-muted">Uploading file…</p>
      ) : null}

      {stage.kind === "uploading-sentences" ? (
        <p className="text-sm text-muted">
          Saving sentences ({stage.uploaded} / {stage.total})…
        </p>
      ) : null}

      {stage.kind === "redirecting" ? (
        <p className="text-sm text-muted">Done. Redirecting…</p>
      ) : null}

      {stage.kind === "error" ? (
        <div className="rounded-md border-l-2 border-danger bg-danger-soft px-3 py-2">
          <p role="alert" className="text-sm text-danger">
            {stage.message}
          </p>
          <button
            type="button"
            onClick={reset}
            className="mt-2 text-xs text-fg underline underline-offset-4 hover:text-muted"
          >
            Pick a different file
          </button>
        </div>
      ) : null}

      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={onSubmit}
          disabled={!file || busy || stage.kind === "error"}
          className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-accent-fg transition-colors hover:bg-accent-hover disabled:opacity-50"
        >
          {busy ? "Working…" : "Upload"}
        </button>
        {file && !busy ? (
          <button
            type="button"
            onClick={reset}
            className="text-sm text-muted underline-offset-4 hover:text-fg hover:underline"
          >
            Clear
          </button>
        ) : null}
      </div>

      <p className="text-xs text-subtle">
        We parse text in your browser, then upload only the file and a sentence
        index. Scanned image-only PDFs aren&apos;t supported.
      </p>
    </div>
  );
}
