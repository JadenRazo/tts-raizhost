// Virtual timeline for the reader.
//
// Why this exists: each sentence is its own short <audio src> (typically
// 2-8 seconds). Without a virtual timeline, MediaSession's
// setPositionState reports per-sentence duration to the OS — which means
// the lock-screen scrubber and CarPlay scrubber think the "track" is
// only a few seconds long, and seekforward(15s) clamps to no-op.
//
// This module presents the book as one virtual track:
//   - `totalDuration` ≈ sum of estimated per-sentence durations
//   - `cumulative[i]` = virtual time at the start of sentence i
//   - `virtualToIdx(t)` and `idxToVirtual(i, offsetWithinSentence)`
//
// Estimates use a fixed characters-per-second rate divided by playback
// speed. As real audio durations come in via `loadedmetadata`, callers
// can refine individual entries — but only for sentences whose actual
// duration is known. The scrubber lying by ±10% on un-played sentences
// is fine; the scrubber being stuck at "0:05 of 0:08" while a 4-hour
// book plays is not.

const CHARS_PER_SECOND_AT_1X = 14; // empirical; tune from production data

export type Timeline = {
  // Per-sentence duration in seconds. Length === sentenceCount.
  durations: Float64Array;
  // cumulative[i] = sum(durations[0..i-1]) ; cumulative[0] = 0.
  // Length === sentenceCount + 1; cumulative[sentenceCount] === totalDuration.
  cumulative: Float64Array;
  totalDuration: number;
};

/** Estimate seconds for a sentence based on its character count and the
 *  current playback speed. Speed >1 shortens duration. Floor at 0.5s
 *  to avoid degenerate cases (e.g. "Yes." would be 0.07s otherwise,
 *  which makes the virtual scrubber jitter). */
export function estimateSentenceSeconds(text: string, speed: number): number {
  const charCount = text.length;
  const baseSeconds = Math.max(0.5, charCount / CHARS_PER_SECOND_AT_1X);
  const safeSpeed = Number.isFinite(speed) && speed > 0 ? speed : 1;
  return baseSeconds / safeSpeed;
}

/** Build a timeline from a (possibly sparse) list of loaded sentences,
 *  the total sentence count for the book, and the current speed.
 *
 *  Sentences that haven't been loaded yet are estimated by the
 *  fallback duration (`fallbackPerSentenceSeconds`) so the virtual
 *  total stays roughly proportional to the book length. As more
 *  sentences load, callers should rebuild — `useMemo` on
 *  `(sentences, sentenceCount, speed)` is the intended call site. */
export function buildTimeline(args: {
  sentenceCount: number;
  loadedSentences: Map<number, { text: string }>;
  /** Real audio durations from <audio>'s loadedmetadata event, indexed
   *  by sentence idx. Optional — when unset, we fall back to text
   *  estimates. */
  measuredDurations?: Map<number, number>;
  speed: number;
  /** Used when neither a real duration nor a known text exists.
   *  Default 4s — tuned for an average English sentence at 1x. */
  fallbackPerSentenceSeconds?: number;
}): Timeline {
  const {
    sentenceCount,
    loadedSentences,
    measuredDurations,
    speed,
    fallbackPerSentenceSeconds = 4,
  } = args;

  const safeSpeed = Number.isFinite(speed) && speed > 0 ? speed : 1;
  const fallbackScaled = fallbackPerSentenceSeconds / safeSpeed;

  const durations = new Float64Array(sentenceCount);
  for (let i = 0; i < sentenceCount; i++) {
    const measured = measuredDurations?.get(i);
    if (typeof measured === "number" && Number.isFinite(measured) && measured > 0) {
      durations[i] = measured;
      continue;
    }
    const sentence = loadedSentences.get(i);
    if (sentence) {
      durations[i] = estimateSentenceSeconds(sentence.text, safeSpeed);
      continue;
    }
    durations[i] = fallbackScaled;
  }

  const cumulative = new Float64Array(sentenceCount + 1);
  let running = 0;
  for (let i = 0; i < sentenceCount; i++) {
    cumulative[i] = running;
    running += durations[i];
  }
  cumulative[sentenceCount] = running;

  return {
    durations,
    cumulative,
    totalDuration: running,
  };
}

/** Convert a virtual time (seconds, 0..totalDuration) to (idx, offset).
 *  Out-of-range inputs are clamped. Empty timelines return idx=0 offset=0. */
export function virtualToIdx(
  virtualSeconds: number,
  timeline: Timeline,
): { idx: number; offsetWithinSentence: number } {
  const sentenceCount = timeline.durations.length;
  if (sentenceCount === 0) return { idx: 0, offsetWithinSentence: 0 };
  if (!Number.isFinite(virtualSeconds) || virtualSeconds <= 0) {
    return { idx: 0, offsetWithinSentence: 0 };
  }
  if (virtualSeconds >= timeline.totalDuration) {
    return {
      idx: sentenceCount - 1,
      offsetWithinSentence: timeline.durations[sentenceCount - 1],
    };
  }
  // Binary search on cumulative for the largest i such that
  // cumulative[i] <= virtualSeconds. Linear is fine for small books;
  // bsearch matters once a book is in the thousands of sentences.
  let lo = 0;
  let hi = sentenceCount; // cumulative has sentenceCount+1 entries
  while (lo + 1 < hi) {
    const mid = (lo + hi) >> 1;
    if (timeline.cumulative[mid] <= virtualSeconds) lo = mid;
    else hi = mid;
  }
  const idx = lo;
  const offsetWithinSentence = Math.max(
    0,
    virtualSeconds - timeline.cumulative[idx],
  );
  return { idx, offsetWithinSentence };
}

/** Inverse of `virtualToIdx`. `offsetWithinSentence` is clamped to
 *  [0, durations[idx]]. */
export function idxToVirtual(
  idx: number,
  offsetWithinSentence: number,
  timeline: Timeline,
): number {
  const sentenceCount = timeline.durations.length;
  if (sentenceCount === 0) return 0;
  const clampedIdx = Math.max(0, Math.min(sentenceCount - 1, idx));
  const sentenceDuration = timeline.durations[clampedIdx];
  const safeOffset = Math.max(
    0,
    Math.min(sentenceDuration, Number.isFinite(offsetWithinSentence) ? offsetWithinSentence : 0),
  );
  return timeline.cumulative[clampedIdx] + safeOffset;
}
