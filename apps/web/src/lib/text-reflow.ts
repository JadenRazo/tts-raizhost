// Canonical PDF-text post-processing helpers shared by the upload form
// (browser-side pdfjs extraction), the sentence-insert API route, and the
// one-shot backfill script.
//
// Three layers because PDF chapter titles get letter-tracked, and the
// symptom "N i n e   s u g g e s t i o n s" comes from one of:
//   (a) pdfjs inserts U+0020 between glyphs of TJ-positioned text so a
//       single TextItem arrives as `str: "N i n e"`.
//   (b) PDFs that emit one Tj per glyph give one TextItem per letter.
//   (c) Invisibles (soft-hyphen, ZWSP, BOM, ...) between glyphs that
//       pdfjs's normalizer rewrites to U+0020.
// `flowTextItems` handles (b) via geometry. `stripInvisibles` removes
// the chars in (c) before they can be misread. `reflowSpacedGlyphs` is
// the safety net for (a) and any cross-item residue.

// Invisibles to strip. Codepoints listed individually for review; we
// build the regex via String.fromCharCode to keep the source ASCII.
// We KEEP U+00A0 (NBSP) and U+2007-U+2009 (real whitespace).
const INVISIBLE_CODEPOINTS: ReadonlyArray<number | [number, number]> = [
  0x00ad,            // soft hyphen
  0x034f,            // combining grapheme joiner
  0x061c,            // arabic letter mark
  0x115f, 0x1160,    // hangul choseong/jungseong fillers
  0x17b4, 0x17b5,    // khmer invisibles
  0x180e,            // mongolian vowel separator
  [0x200b, 0x200f],  // ZWSP / ZWNJ / ZWJ / LRM / RLM
  0x2028, 0x2029,    // line / paragraph separator
  [0x202a, 0x202e],  // bidi controls
  [0x2060, 0x206f],  // word joiner / function-app invisibles / deprecated language tags
  0x3164,            // hangul filler
  0xfeff,            // BOM / zero-width no-break space
  0xffa0,            // halfwidth hangul filler
];

const INVISIBLES = new RegExp(
  "[" +
    INVISIBLE_CODEPOINTS.map((cp) =>
      Array.isArray(cp)
        ? String.fromCodePoint(cp[0]) + "-" + String.fromCodePoint(cp[1])
        : String.fromCodePoint(cp),
    ).join("") +
  "]",
  "g",
);

export function stripInvisibles(s: string): string {
  return s.replace(INVISIBLES, "");
}

const SINGLE = /^[A-Za-z]$/;

export function reflowSpacedGlyphs(input: string): string {
  const text = stripInvisibles(input);
  const tokens = text.split(/(\s+)/);
  const out: string[] = [];
  let i = 0;
  while (i < tokens.length) {
    if (SINGLE.test(tokens[i])) {
      const letters: string[] = [];
      let j = i;
      while (j < tokens.length && SINGLE.test(tokens[j])) {
        letters.push(tokens[j]);
        const continuesRun =
          j + 2 < tokens.length &&
          /^ $/.test(tokens[j + 1]) &&
          SINGLE.test(tokens[j + 2]);
        if (continuesRun) {
          j += 2;
        } else {
          j += 1;
          break;
        }
      }
      if (letters.length >= 4) {
        out.push(letters.join(""));
        i = j;
        continue;
      }
    }
    out.push(tokens[i]);
    i++;
  }
  return out.join("");
}

export type RawTextItem = {
  str?: string;
  transform?: number[];
  width?: number;
  height?: number;
  hasEOL?: boolean;
};

export function flowTextItems(items: ReadonlyArray<RawTextItem>): string {
  let out = "";
  let prev: { endX: number; y: number; w: number; h: number } | null = null;
  for (const it of items) {
    const raw = typeof it.str === "string" ? it.str : "";
    const cleaned = reflowSpacedGlyphs(stripInvisibles(raw));
    if (cleaned.length === 0) {
      if (it.hasEOL) out += "\n";
      continue;
    }
    const x = it.transform?.[4] ?? 0;
    const y = it.transform?.[5] ?? 0;
    const w = it.width ?? 0;
    const h = it.height ?? 0;
    if (prev) {
      const sameLine = Math.abs(y - prev.y) < Math.max(h, prev.h) * 0.5;
      if (!sameLine) {
        out += "\n";
      } else {
        const gap = x - prev.endX;
        // Height-relative threshold: real word gaps scale with font size,
        // letter-tracking gaps are smaller than ~25% of the line height.
        // Width-relative thresholds break for narrow glyphs ("i", "t", "l")
        // because the threshold collapses with the glyph and false-fires
        // on normal tracking. Floor of 1pt to handle missing-height items.
        const heightRef = Math.max(prev.h, h, 1);
        const threshold = heightRef * 0.25;
        if (gap > threshold && !/\s$/.test(out) && !/^\s/.test(cleaned)) {
          out += " ";
        }
      }
    }
    out += cleaned;
    if (it.hasEOL) out += "\n";
    prev = { endX: x + w, y, w, h };
  }
  return out;
}
