// Copy the pinned pdfjs-dist worker into public/ so it ships with the
// build artifact. Self-hosting (vs. a CDN) means our SRI guarantees
// match the version we tested against, and a CDN compromise can't
// silently exfiltrate uploaded PDFs (the worker sees the bytes pre-
// upload).
//
// Runs as `prebuild` and `predev` so the file stays in sync with the
// installed pdfjs-dist whenever package versions change.

import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoDir = resolve(__dirname, "..");
const src = resolve(
  repoDir,
  "node_modules/pdfjs-dist/legacy/build/pdf.worker.min.mjs",
);
const dst = resolve(repoDir, "public/pdf.worker.min.mjs");

mkdirSync(dirname(dst), { recursive: true });
copyFileSync(src, dst);
console.log(`[pdfjs-worker] copied ${src} -> ${dst}`);
