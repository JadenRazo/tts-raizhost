// Smart pacing: variable inter-sentence pause based on linguistic and
// structural signals. Real audiobook narrators don't read every
// sentence with the same gap to the next; they pause longer at the
// end of a paragraph or chapter and shorter mid-thought. We don't have
// real prosody from a TTS model, so we approximate by inspecting the
// previous sentence's ending punctuation and whether the next sentence
// crosses a page or chapter boundary.
//
// Returned value is in *milliseconds of additional silence beyond the
// natural ~50ms src-swap gap*. The reader inserts this delay between
// the current sentence's `ended` event and the next sentence's first
// `play()`. Capped at 1500ms — anything longer feels like a stall.

const PACING_BASE_MS = 0;
const PACING_QUESTION_OR_EXCLAIM_MS = 120;
const PACING_PAGE_BOUNDARY_MS = 280;
const PACING_CHAPTER_BOUNDARY_MS = 600;
const PACING_LONG_SENTENCE_MS = 60; // > 35 words
const PACING_MAX_MS = 1500;

export type PacingContext = {
  /** Text of the sentence that just ended. */
  endedText: string;
  /** Page numbers; if different, we treat it as a paragraph-likely break. */
  endedPage: number;
  nextPage: number | undefined;
  /** Whether the next sentence is the start of a new chapter. */
  nextIsChapterStart: boolean;
};

/** Compute the pause duration between two sentences in ms. */
export function computeInterSentencePauseMs(ctx: PacingContext): number {
  let total = PACING_BASE_MS;

  const trimmed = ctx.endedText.trimEnd();
  const lastChar = trimmed.charAt(trimmed.length - 1);
  if (lastChar === "?" || lastChar === "!") {
    total += PACING_QUESTION_OR_EXCLAIM_MS;
  }

  const wordCount = (ctx.endedText.match(/\S+/g) ?? []).length;
  if (wordCount > 35) {
    total += PACING_LONG_SENTENCE_MS;
  }

  if (ctx.nextPage !== undefined && ctx.nextPage !== ctx.endedPage) {
    total += PACING_PAGE_BOUNDARY_MS;
  }

  if (ctx.nextIsChapterStart) {
    total += PACING_CHAPTER_BOUNDARY_MS;
  }

  return Math.max(0, Math.min(PACING_MAX_MS, total));
}
