// Sentence-level cleanup for TTS listening quality.
//
// Runs in four places:
//   1. Client upload (upload-form.tsx) — applied per sentence, then a
//      sequence-level pass merges abbreviation false-splits.
//   2. Server insert route (api/books/[id]/sentences) — defensive second
//      pass so legacy/external clients can't bypass the rules.
//   3. Backfill script (scripts/cleanup-existing-sentences.ts) — re-runs
//      the same pipeline on already-imported books.
//   4. Public-library seed (scripts/seed-public-books.ts) — applied per
//      sentence on Gutenberg plaintext before insert.
//
// Design constraints:
//   - Pure functions, no DOM or Node APIs, so the same module compiles for
//     the browser and the server.
//   - Idempotent: running twice produces the same result as running once.
//   - Lossy in the "drop unlistenable junk" sense; never modifies meaning
//     of real prose. When in doubt, leave the sentence as-is rather than
//     mis-clean it.
//
// What the symptoms look like in stored sentences (audited 2026-04-30):
//   - Project-Gutenberg italic underscores: "_The sleeping Fox_" → "The sleeping Fox"
//   - Inline footnote markers: "...{31}" and "[1]" → stripped
//   - "[Illustration: FRANKLIN ARMS]" caption blocks → stripped
//   - Standalone "II.", "III." chapter dividers → dropped
//   - Index dumps in book backmatter → dropped
//   - Project Gutenberg header/footer boilerplate → dropped at edges
//   - "Mr.", "Dr.", "No." treated as full sentences → merged with next
//   - Letter-tracked headings ("M A R C U S") → reflowed to "MARCUS"
//   - All-caps name openers ("MARCUS AURELIUS ANTONINUS was born") that
//     misaki/eSpeak G2P would otherwise spell letter-by-letter → title-cased

import { reflowSpacedGlyphs } from "./text-reflow";

// ---------------------------------------------------------------------------
// Per-sentence text rewrite. Returns the cleaned string. Never returns null;
// drop decisions live in `isUnlistenable`.
// ---------------------------------------------------------------------------

const ILLUSTRATION_BLOCK = /\[(?:Illustration|Picture|Image|Sidebar|Footnote|End of [^\]]+)\b[^\]]*\]/gi;
// {1}, {12}, {12a}, and the spaced-out variants Project-Gutenberg PDFs
// emit when a virtues-table cell wraps across columns ("{ 1}", "{ 12 }").
const BRACED_FOOTNOTE = /\{\s*\d+[a-z]?\s*\}/g;
// Orphan closing-brace glyphs left over from the same table layout ("2}",
// "5}"). Anchored to a word boundary on the left so legit text like
// "set x = 2}" in code listings stays intact (books rarely contain that
// shape and the cost of a false-positive on a digit-then-brace token is
// near zero — TTS already mangles it).
const ORPHAN_CLOSE_BRACE = /\b\d+\}/g;
const BRACKET_FOOTNOTE = /\[\d+[a-z]?\]/g;

// Markdown-style italics: "_word_" or "_a phrase here_". Greedy match is
// dangerous (would consume across multiple italic spans on the same line),
// so we use a non-greedy run that disallows newlines and embedded
// underscores. Underscores adjacent to alphanumerics in tokens like
// "snake_case" are left alone because both bordering chars are word chars,
// failing the (?<!\w) / (?!\w) lookarounds in the leading/trailing pair.
const ITALIC_PAIR = /(?<![\w_])_([^_\n]{1,200}?)_(?!\w)/g;

// Unicode whitespace characters that need to look like a regular space to
// the TTS frontend. NBSP and the figure-space family are common in PDF
// text; the narrow-no-break space appears in French typography. Listed via \u escapes so the source stays ASCII and can't accidentally form a range across real punctuation (em-dash sits at U+2014).
const UNICODE_WS = /[\u00a0\u1680\u2000-\u200a\u202f\u205f\u3000]/g;

// Control chars except \t and \n (those don't survive the whitespace
// collapse below anyway, and stripping them upstream broke nothing in
// stored sentences). Excludes \x09 (TAB) and \x0a (LF) so replace can be
// safe even if any callsite ever needs to preserve them.
const CONTROL_CHARS = /[\x00-\x08\x0B-\x1F\x7F]/g;

const WS_RUN = /[ \t]+/g;
const NEWLINE_RUN = /\s*\n\s*/g;

// Soft-hyphenated line-break joiner. The reflow path already strips U+00AD
// at extraction time, but ASCII-hyphen + newline still leaks through for
// PDFs whose extractor emits a real "-\n" pair. Keep this conservative:
// only join when both sides are letters, so "well-\nmade" → "wellmade"
// (correct) and "1995-\n1999" stays as-is (numbers, likely a real range).
const HYPHENATED_LINEBREAK = /([a-zA-Z])-\s*\n\s*([a-zA-Z])/g;

export function cleanSentenceText(input: string): string {
  let s = input;
  s = s.replace(ILLUSTRATION_BLOCK, "");
  s = s.replace(BRACED_FOOTNOTE, "");
  s = s.replace(ORPHAN_CLOSE_BRACE, "");
  s = s.replace(BRACKET_FOOTNOTE, "");
  s = s.replace(ITALIC_PAIR, "$1");
  s = s.replace(UNICODE_WS, " ");
  s = s.replace(CONTROL_CHARS, "");
  s = s.replace(HYPHENATED_LINEBREAK, "$1$2");
  s = s.replace(NEWLINE_RUN, " ");
  s = s.replace(WS_RUN, " ");
  // Catch letter-tracked spans that survived (or never went through)
  // PDF-extraction reflow: "M A R C U S" → "MARCUS". Idempotent, so
  // double-calling from upload-form / insert route is harmless.
  s = reflowSpacedGlyphs(s);
  // Demote shouty all-caps name runs so the G2P doesn't spell them out.
  s = desShoutCase(s);
  return s.trim();
}

// ---------------------------------------------------------------------------
// All-caps "shout" demotion.
//
// Kokoro/misaki's G2P (eSpeak NG under the hood) spells unrecognized
// uppercase tokens letter-by-letter — so "MARCUS AURELIUS ANTONINUS was
// born…" is read aloud as "M-A-R-C-U-S A-U-R-E-L-I-U-S A-N-T-O-N-I-N-U-S
// was born…". The fix is to title-case shouty runs *before* they hit
// the synth, while leaving real acronyms (NASA, FBI, BBC) alone so they
// keep being spelled, which is what listeners expect.
//
// Heuristics, deliberately conservative:
//   - Multi-token runs (≥2 adjacent all-caps tokens, only single
//     whitespace between them) are demoted only when every token in the
//     run has ≥4 letters. Catches "MARCUS AURELIUS ANTONINUS"; leaves
//     "FBI AGENT JONES" alone (FBI is 3 letters, run fails the gate).
//   - Single all-caps tokens are demoted only at length ≥5. PARIS,
//     RADAR, MEDITATIONS get title-cased; NASA, OPEC, IEEE stay as-is
//     and the G2P spells them, which is correct.
//   - Whole-sentence-uppercase content (>85% letter-uppercase) is left
//     alone. That's a heading shape and isLikelyHeading-style filters
//     should drop the row, not rewrite it.
//   - Leading/trailing punctuation is preserved so "(MARCUS," stays
//     wrapped after demotion: "(Marcus,".
// ---------------------------------------------------------------------------

const LEAD_PUNCT = /^["'(\[]+/;
const TRAIL_PUNCT = /["'.,;:!?)\]]+$/;

function shoutTokenCore(token: string): string | null {
  const lead = LEAD_PUNCT.exec(token)?.[0]?.length ?? 0;
  const trail = TRAIL_PUNCT.exec(token)?.[0]?.length ?? 0;
  const core = token.slice(lead, token.length - trail);
  if (core.length < 2) return null;
  for (let i = 0; i < core.length; i++) {
    const c = core.charCodeAt(i);
    if (c < 65 || c > 90) return null;
  }
  return core;
}

function titleCaseToken(token: string): string {
  const lead = LEAD_PUNCT.exec(token)?.[0] ?? "";
  const trail = TRAIL_PUNCT.exec(token)?.[0] ?? "";
  const core = token.slice(lead.length, token.length - trail.length);
  if (core.length === 0) return token;
  return lead + core[0] + core.slice(1).toLowerCase() + trail;
}

export function desShoutCase(text: string): string {
  const letters = (text.match(/[A-Za-z]/g) ?? []).length;
  if (letters < 4) return text;
  const upper = (text.match(/[A-Z]/g) ?? []).length;
  if (upper / letters > 0.85) return text;

  const parts = text.split(/(\s+)/);
  const cores: (string | null)[] = parts.map((p) => {
    if (p.length === 0 || /^\s+$/.test(p)) return null;
    return shoutTokenCore(p);
  });

  const convert = new Array<boolean>(parts.length).fill(false);
  let i = 0;
  while (i < parts.length) {
    const c = cores[i];
    if (c === null || c.length < 4) {
      i++;
      continue;
    }
    let runEnd = i;
    let j = i;
    while (
      j + 2 < parts.length &&
      /^\s+$/.test(parts[j + 1] ?? "") &&
      cores[j + 2] !== null &&
      (cores[j + 2] as string).length >= 4
    ) {
      j += 2;
      runEnd = j;
    }
    const runCount = (runEnd - i) / 2 + 1;
    if (runCount >= 2) {
      for (let k = i; k <= runEnd; k += 2) convert[k] = true;
    } else if (c.length >= 5) {
      convert[i] = true;
    }
    i = runEnd + 1;
  }

  for (let k = 0; k < parts.length; k++) {
    if (convert[k]) parts[k] = titleCaseToken(parts[k]);
  }
  return parts.join("");
}

// ---------------------------------------------------------------------------
// Drop decision. Returns true if the sentence is content the user does not
// want read aloud — Roman-numeral chapter dividers, dot-leader rows from
// table-of-contents, index entries, Project-Gutenberg boilerplate, etc.
// ---------------------------------------------------------------------------

const ROMAN_ONLY = /^[IVXLCDM]+\.?$/;
const DIGIT_ONLY = /^\d+\.?$/;

const ASCII_TABLE_BORDER = /[+|][-=]{2,}|[-=]{2,}[+|]/;
const DOT_LEADER_RUN = /\.{6,}/;

// Edge-of-book boilerplate. Anchored at the start of the sentence so a
// real prose mention like "...the company published a Library of
// Congress catalog..." does not trigger.
const BOILERPLATE_PREFIXES = [
  /^Produced by\b/i,
  /^HTML version\b/i,
  /^Copyright[\s,]/i,
  /^All rights reserved\b/i,
  /^Project Gutenberg\b/i,
  /^End of (?:the )?Project\b/i,
  /^End of (?:the )?trancription/i,    // sic — appears verbatim in Franklin
  /^End of (?:the )?transcription/i,
  /^ISBN[\s:0-9]/i,
  /^Library of Congress\b/i,
  /^For more information\b/i,
  /^Printed in (?:the )?(?:U\.?S\.?A?\.?|United States|Great Britain)/i,
  /^Manufactured in (?:the )?(?:U\.?S\.?A?\.?|United States)/i,
  /^About (?:Dale Carnegie|the [Aa]uthor)\b/,
  /^This (?:e?[Bb]ook|edition) (?:is|was)/i,
  /^www\.\S+$/i,
  // Project-Gutenberg transcriber's note conventions.
  /^Variations? in (?:spelling|hyphenation|punctuation)/i,
  /^The following (?:change|changes) (?:has|have) been made/i,
  /^Transcriber'?s? [Nn]ote/i,
  /^Errata\s*[:.]/i,
  // Marketing back-matter on training/seminar books.
  /^[A-Z][A-Za-z\s]+ Training (?:offers|provides|delivers)/,
  /^[A-Z][A-Za-z'\s]+'s corporate (?:specialists|programs)/,
];

const PUBLISHER_LINE = /^[A-Z][A-Z\s,.'&-]{6,}\b(COMPANY|COMPANIES|PRESS|PUBLISHERS?|PUBLISHING|HOUSE|BOOKS|EDITION|TRAINING)\b/;

// "Smith, John, 25, 47–49, 102; Jones, Mary, 30, 88..." — index lines have
// many comma-or-semicolon-separated capitalized name tokens followed by
// number ranges. We only apply this in the trailing window of a book.
const INDEX_NUMBER_TOKEN = /\b\d+(?:[–\-]\d+)?\b/g;
const INDEX_NAME_TOKEN = /\b[A-Z][a-zA-Z]{2,}\b/g;

export type DropContext = {
  /** Zero-based index of the sentence within the book. */
  idx: number;
  /** Total sentence count for the book (post-cleanup is fine; pre is fine).  */
  total: number;
};

export function isUnlistenable(text: string, ctx?: DropContext): boolean {
  const t = text.trim();
  if (t.length === 0) return true;
  if (t.length < 3) return true;

  if (ROMAN_ONLY.test(t)) return true;
  if (DIGIT_ONLY.test(t)) return true;

  if (ASCII_TABLE_BORDER.test(t)) return true;

  // Multiple dot-leader runs anywhere → table-of-contents or ledger row.
  // One short run is OK ("...he said.").
  const leaderHits = (t.match(/\.{4,}/g) ?? []).length;
  if (leaderHits >= 2) return true;
  if (DOT_LEADER_RUN.test(t)) return true;

  // High non-letter density indicates the text is not prose — math tables,
  // pure number ledgers, ASCII art. 40% threshold is conservative; real
  // dialogue with quotes and commas sits comfortably under 30%.
  const letters = (t.match(/[a-zA-Z]/g) ?? []).length;
  const nonWs = t.replace(/\s/g, "").length;
  if (nonWs >= 12 && letters / nonWs < 0.55) return true;

  // Index detection: only in the last 5% of the book, and only when the
  // sentence has many number-or-range tokens AND many capitalized name
  // tokens. Intentionally conservative — a Carnegie-style index entry
  // hits ~12 of each, but real prose appendices in Self-Help, Franklin,
  // and Art of War contain dense historical narrative with comparable
  // name/number density, so a tighter threshold creates false positives
  // on legitimate content.
  if (ctx && ctx.total > 100) {
    const tailStart = Math.floor(ctx.total * 0.95);
    if (ctx.idx >= tailStart) {
      const numHits = (t.match(INDEX_NUMBER_TOKEN) ?? []).length;
      const nameHits = (t.match(INDEX_NAME_TOKEN) ?? []).length;
      if (numHits >= 4 && nameHits >= 4) return true;
    }
  }

  // Edge-of-book boilerplate (front 30, back 30).
  if (ctx && (ctx.idx < 30 || ctx.idx >= ctx.total - 30)) {
    for (const pat of BOILERPLATE_PREFIXES) {
      if (pat.test(t)) return true;
    }
    if (PUBLISHER_LINE.test(t)) return true;
  }

  return false;
}

// ---------------------------------------------------------------------------
// Sequence-level fix: when sentence segmentation split on "Mr." or "Dr.",
// merge the resulting fragment with its successor.
//
// The list is intentionally conservative — only abbreviations that are
// almost never legitimate sentence-final tokens. "Inc." and "Ltd." are
// excluded because companies often end sentences ("...subsidiary of Acme
// Inc.") and merging would destroy real boundaries.
// ---------------------------------------------------------------------------

const ABBREVIATIONS = [
  "Mr", "Mrs", "Ms", "Dr", "Jr", "Sr", "St", "Prof", "Rev", "Hon",
  "Capt", "Col", "Lt", "Gen", "Sgt", "Cmdr",
  "U\\.S", "D\\.C", "H\\.G", "H\\.W", "J\\.F", "P\\.S",
  "e\\.g", "i\\.e", "etc", "vs", "No", "cf", "vol", "ch", "fig",
  "A\\.D", "B\\.C", "A\\.M", "P\\.M",
];

const ABBREV_TAIL = new RegExp(
  "\\b(?:" + ABBREVIATIONS.join("|") + ")\\.$",
);

const STARTS_WITH_CAP = /^["“‘'(\[]?[A-Z]/;

export type SegmentedSentence = { idx: number; page: number; text: string };

export function mergeAbbreviationSplits(
  sentences: ReadonlyArray<SegmentedSentence>,
  maxLen = 1500,
): SegmentedSentence[] {
  if (sentences.length === 0) return [];

  const merged: { page: number; text: string }[] = [];
  for (const s of sentences) {
    const last = merged[merged.length - 1];
    const prevEndsAbbrev = last && ABBREV_TAIL.test(last.text);
    const nextStartsCap = STARTS_WITH_CAP.test(s.text);
    const wouldFit = last && last.text.length + 1 + s.text.length <= maxLen;
    if (last && prevEndsAbbrev && nextStartsCap && wouldFit) {
      last.text = last.text + " " + s.text;
      continue;
    }
    merged.push({ page: s.page, text: s.text });
  }

  return merged.map((m, i) => ({ idx: i, page: m.page, text: m.text }));
}

// ---------------------------------------------------------------------------
// Composite pipeline: clean each sentence, drop the unlistenable ones,
// merge abbreviation splits, re-index. Used by the upload form and the
// backfill script. Returns rows ready to insert.
// ---------------------------------------------------------------------------

export function cleanupSentencePipeline(
  sentences: ReadonlyArray<{ page: number; text: string }>,
): SegmentedSentence[] {
  // Stage 1: rewrite each sentence in place, keeping page metadata.
  const rewritten: { page: number; text: string }[] = [];
  for (const s of sentences) {
    const cleaned = cleanSentenceText(s.text);
    if (cleaned.length === 0) continue;
    rewritten.push({ page: s.page, text: cleaned });
  }
  if (rewritten.length === 0) return [];

  // Stage 2: drop unlistenable sentences using positional context derived
  // from the post-rewrite total. The total is approximate (we drop more
  // below) but accurate enough for the "first 30 / last 30" windows.
  const total = rewritten.length;
  const surviving: { page: number; text: string }[] = [];
  for (let i = 0; i < rewritten.length; i++) {
    if (isUnlistenable(rewritten[i].text, { idx: i, total })) continue;
    surviving.push(rewritten[i]);
  }
  if (surviving.length === 0) return [];

  // Stage 3: merge abbreviation false-splits and re-index.
  const indexed = surviving.map((s, i) => ({ idx: i, page: s.page, text: s.text }));
  return mergeAbbreviationSplits(indexed);
}
