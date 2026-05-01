"use client";

// Reader UI. One persistent <audio> element drives playback; src changes
// per sentence and the `ended` event advances to the next idx.
//
// Why per-sentence src instead of MediaSource?
//   - MSE requires segmented Opus / WebM Opus; ffmpeg's plain `pipe:1 -f
//     opus` output isn't directly playable through MSE without an extra
//     remuxing pass on the server.
//   - A plain <audio src=...> works in every browser, no codec quirks.
//   - Tradeoff: ~50 ms gap between sentences. Acceptable for v1
//     reading-aloud UX. A future Phase 6.5 can swap in MSE if the gap
//     becomes a real complaint.
//
// The /api/tts response carries `Cache-Control: private, max-age=86400,
// immutable`, so re-playing a sentence is a zero-fetch local replay — the
// browser HTTP cache hands the bytes back without us doing anything.

import {
  type ReactElement,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import {
  type KokoroBackend,
  getCachedBackend,
  pickKokoroBackend,
} from "@/lib/gpu-capability";
import {
  type ClientState,
  type LoadProgress,
  getClient,
} from "@/lib/kokoro-webgpu-client";
import {
  DEFAULT_HARDWARE_CONTROLS,
  type HardwareControlSettings,
  type NavigationHandlers,
  dispatchMediaAction,
} from "@/lib/media-actions";
import { rum } from "@/lib/rum";
import {
  buildTimeline,
  idxToVirtual,
  virtualToIdx,
} from "@/lib/sentence-timeline";
import {
  FADE_DURATION_MS,
  fadeVolumeForRemaining,
  type SleepTimerMode,
} from "@/lib/sleep-timer";
import { fetchAudio } from "@/lib/tts-client-routing";
import type { Voice } from "@/lib/tts-client";
import {
  useMediaSession,
  type MediaSessionPositionState,
} from "@/lib/use-media-session";
import { generateCoverArtwork } from "@/lib/cover-artwork";
import { computeInterSentencePauseMs } from "@/lib/smart-pacing";
import {
  BookmarksPanel,
  type BookmarkEntry,
} from "@/app/_components/bookmarks-panel";
import { ChaptersPanel } from "@/app/_components/chapters-panel";
import { HardwareControlsSettings } from "@/app/_components/hardware-controls-settings";
import { SleepTimerControl } from "@/app/_components/sleep-timer-control";

export type ReaderSentence = {
  idx: number;
  page: number;
  text: string;
};

export type ReaderChapter = {
  id: string;
  title: string;
  startSentenceIdx: number;
  depth: number;
  ord: number;
};

type Position = { sentenceIdx: number; charOffset: number };

type Props = {
  bookId: string;
  title: string;
  author: string | null;
  sentenceCount: number;
  initialSentences: ReaderSentence[];
  initialPosition: Position;
  initialVoiceId: string;
  initialSpeed: number;
  voices: Voice[];
  /** Per-user mapping of CarPlay / Bluetooth / lock-screen controls to
   *  reader actions. The reader still works without this (defaults are
   *  applied), but callers should pass the persisted settings so a
   *  reload preserves the user's mapping. */
  hardwareControls?: HardwareControlSettings;
  /** Auto-rewind by this many seconds when Play is pressed after a pause
   *  longer than 30 seconds. 0 disables. Within-sentence clamp — never
   *  crosses into a previous sentence so the audio stream isn't disrupted. */
  smartRewindSeconds?: number;
  /** Default duration the sleep-timer button preselects when the user
   *  opens it. The active duration is per-session client state. */
  sleepTimerDefaultMinutes?: number;
  /** Chapters extracted from the PDF outline at upload time, sorted by
   *  outline order. Empty array when the PDF had no usable outline —
   *  in that case the reader's chapter actions fall through to page
   *  navigation (configured in media-actions.ts). */
  initialChapters?: ReaderChapter[];
};

type AlertState =
  | { kind: "service-warming"; retryAt: number }
  | { kind: "synth-failed"; idx: number; advanceAt: number }
  | { kind: "end-of-book" }
  | null;

// Mirrors apps/web/src/app/api/tts/route.ts:ALLOWED_SPEEDS. Off-list
// values are 400'd at the API edge, so the picker never offers them.
const SPEED_OPTIONS = [0.75, 1.0, 1.25, 1.5];
const POSITION_DEBOUNCE_MS = 1_000;
const PAGE_FETCH_THRESHOLD = 10;
const PAGE_FETCH_LIMIT = 50;
const SERVICE_RETRY_MS = 5_000;
const AUTO_ADVANCE_AFTER_FAIL_MS = 1_500;
const STALL_TIMEOUT_MS = 4_000;
const MAX_PER_IDX_RETRIES = 2;
// Debounce prefetch so rapid Next/Prev skipping doesn't queue
// new kokoro synth jobs on every click. The user has to "settle"
// on a sentence for this long before we warm the next one.
const PREFETCH_DEBOUNCE_MS = 800;
// How long the user has to be still (no list scrolling) before the
// reader auto-aligns the active sentence back to center.
const IDLE_AUTO_SCROLL_MS = 5_000;

function ttsUrl(
  bookId: string,
  idx: number,
  voiceId: string,
  speed: number,
): string {
  return (
    `/api/tts?bookId=${encodeURIComponent(bookId)}` +
    `&idx=${idx}` +
    `&voice=${encodeURIComponent(voiceId)}` +
    `&speed=${speed.toFixed(2)}`
  );
}

function clampSpeed(value: number): number {
  if (!Number.isFinite(value)) return 1.0;
  return Math.min(1.5, Math.max(0.75, value));
}

function nearestSpeed(value: number): number {
  let best = SPEED_OPTIONS[0];
  let bestDiff = Math.abs(SPEED_OPTIONS[0] - value);
  for (const opt of SPEED_OPTIONS) {
    const d = Math.abs(opt - value);
    if (d < bestDiff) {
      best = opt;
      bestDiff = d;
    }
  }
  return best;
}

function stepSpeed(current: number, dir: -1 | 1): number {
  const idx = SPEED_OPTIONS.findIndex((s) => s === nearestSpeed(current));
  const next = Math.max(
    0,
    Math.min(SPEED_OPTIONS.length - 1, idx + dir),
  );
  return SPEED_OPTIONS[next];
}

// Pretty-print a Kokoro voice. IDs are `<lang_code><gender>_<name>`
// (e.g. af_heart, bf_emma); we surface the human name and a venus or
// mars symbol.
function voiceDisplayName(v: { id: string }): string {
  const rawName = v.id.split("_").slice(1).join(" ");
  return rawName.charAt(0).toUpperCase() + rawName.slice(1);
}

function voiceDisplaySymbol(v: { gender: string }): string {
  return v.gender === "female" ? "♀" : v.gender === "male" ? "♂" : "";
}

// Single-string variant for the inside of <option>, where we can't
// inject DOM and have to live with the symbol's visual descent.
function voiceDisplayLabel(v: { id: string; gender: string }): string {
  const sym = voiceDisplaySymbol(v);
  return sym ? `${voiceDisplayName(v)} ${sym}` : voiceDisplayName(v);
}

// Render a sentence with word-level karaoke highlighting. We don't have
// real per-word timings from Kokoro, so we estimate the spoken position
// as `progress * wordCount`. This is good enough to give the eye a
// "you are here / look here next" cue without claiming sub-syllable
// accuracy.
//
// Tokenization preserves whitespace as standalone tokens so the
// rendered string round-trips exactly (no collapsed spaces around
// punctuation).

type SentenceTokens = {
  tokens: string[];
  // Map from token index → word index. Whitespace tokens are absent.
  // Built once per sentence so the per-token render loop is O(1) instead
  // of O(N) on the wordPositions array (which used to be `indexOf`
  // inside a map — quadratic at ~4-15 Hz timeupdate).
  tokenToWord: Map<number, number>;
  totalWords: number;
};

function tokenizeSentence(text: string): SentenceTokens {
  const tokens = text.split(/(\s+)/);
  const tokenToWord = new Map<number, number>();
  let wordIdx = 0;
  tokens.forEach((tok, i) => {
    if (tok.trim().length > 0) {
      tokenToWord.set(i, wordIdx);
      wordIdx += 1;
    }
  });
  return { tokens, tokenToWord, totalWords: wordIdx };
}

function renderHighlightedSentence(
  text: string,
  progress: number,
  precomputed: SentenceTokens,
): ReactElement[] {
  const { tokens, tokenToWord, totalWords } = precomputed;
  if (totalWords === 0) {
    return [<span key={0}>{text}</span>];
  }
  const clamped = Math.max(0, Math.min(1, progress));
  const currentWord = Math.min(
    totalWords - 1,
    Math.floor(clamped * totalWords),
  );

  return tokens.map((tok, i) => {
    const wordPos = tokenToWord.get(i);
    if (wordPos === undefined) return <span key={i}>{tok}</span>;
    let cls = "";
    if (wordPos < currentWord) {
      cls = "text-subtle";
    } else if (wordPos === currentWord) {
      cls = "rounded bg-accent px-0.5 font-medium text-accent-fg";
    } else if (wordPos === currentWord + 1) {
      cls = "rounded bg-surface px-0.5 font-medium text-fg";
    }
    return (
      <span key={i} className={cls}>
        {tok}
      </span>
    );
  });
}

export function Reader({
  bookId,
  title,
  author,
  sentenceCount,
  initialSentences,
  initialPosition,
  initialVoiceId,
  initialSpeed,
  voices,
  hardwareControls: initialHardwareControls,
  smartRewindSeconds: initialSmartRewindSeconds,
  sleepTimerDefaultMinutes: initialSleepTimerDefaultMinutes,
  initialChapters,
}: Props) {
  // Chapters never change after upload, so a const-style state is fine
  // — useMemo sorts defensively in case the server ordering ever drifts.
  const chapters = useMemo<ReaderChapter[]>(
    () => [...(initialChapters ?? [])].sort((a, b) => a.ord - b.ord),
    [initialChapters],
  );
  const chaptersByStartIdx = useMemo<ReaderChapter[]>(
    () => [...chapters].sort((a, b) => a.startSentenceIdx - b.startSentenceIdx),
    [chapters],
  );
  const [chaptersOpen, setChaptersOpen] = useState(false);
  const [hardwareControls, setHardwareControls] = useState<HardwareControlSettings>(
    initialHardwareControls ?? DEFAULT_HARDWARE_CONTROLS,
  );
  const [hardwareControlsOpen, setHardwareControlsOpen] = useState(false);
  const [smartRewindSeconds, setSmartRewindSeconds] = useState<number>(
    initialSmartRewindSeconds ?? 5,
  );
  const sleepTimerDefaultMinutes = initialSleepTimerDefaultMinutes ?? 30;
  // Wall-clock timestamp of the last user-or-system pause, used by
  // smart-rewind. Cleared on resume; null when the user has never
  // paused yet this session.
  const pausedAtRef = useRef<number | null>(null);

  // Bookmarks for this book. Lazy-loaded on first panel open so we
  // don't pay the round-trip on every reader mount.
  const [bookmarks, setBookmarks] = useState<BookmarkEntry[]>([]);
  const [bookmarksLoaded, setBookmarksLoaded] = useState(false);
  const [bookmarksOpen, setBookmarksOpen] = useState(false);

  // Sleep timer. Lives in the reader because it has to drive the
  // <audio> element's volume during the fade and pause it at expiry.
  // Mode is the source of truth; remainingMs is a derived display
  // value updated on a 1s tick when the timer is running.
  const [sleepMode, setSleepMode] = useState<SleepTimerMode>({ kind: "off" });
  const [sleepRemainingMs, setSleepRemainingMs] = useState<number | null>(null);
  // Cache the original audio.volume so we can restore it after a fade.
  // The reader doesn't expose volume controls today, so this is always
  // 1, but capturing the value at fade-start guards against a future
  // volume picker.
  const sleepPreFadeVolumeRef = useRef<number>(1);
  // Double-buffered audio: two <audio> elements alternate as
  // active/preload. The active one is the source of MediaSession state
  // and the listener's actual playback. The inactive one holds the
  // *next* sentence pre-decoded so an `ended → next` transition can
  // happen by flipping which element is active rather than tearing
  // down and reloading on the same one — that's where the perceptible
  // ~50ms gap came from before. Manual seek (Prev/Next/list click) and
  // voice/speed change still take the load() path on the active
  // element; only the auto-advance fast path uses the swap.
  const audioRefA = useRef<HTMLAudioElement | null>(null);
  const audioRefB = useRef<HTMLAudioElement | null>(null);
  const [activeAudioKey, setActiveAudioKey] = useState<"A" | "B">("A");
  const activeAudioKeyRef = useRef<"A" | "B">("A");
  useEffect(() => {
    activeAudioKeyRef.current = activeAudioKey;
  }, [activeAudioKey]);
  // The idx currently loaded into the *inactive* element, or null if
  // the inactive element has no fresh preload (e.g. after a manual
  // seek or initial mount).
  const preloadIdxRef = useRef<number | null>(null);
  const getActiveAudio = useCallback((): HTMLAudioElement | null => {
    return activeAudioKeyRef.current === "A"
      ? audioRefA.current
      : audioRefB.current;
  }, []);
  const getInactiveAudio = useCallback((): HTMLAudioElement | null => {
    return activeAudioKeyRef.current === "A"
      ? audioRefB.current
      : audioRefA.current;
  }, []);
  const listRef = useRef<HTMLOListElement | null>(null);
  const itemRefs = useRef<Map<number, HTMLLIElement>>(new Map());

  // The persistent ordered cache of sentences we've loaded so far. Indexed
  // by `idx`; gaps possible if the user seeks far ahead but for now we
  // only ever fetch a contiguous window starting at the current idx.
  const [sentences, setSentences] = useState<ReaderSentence[]>(
    initialSentences,
  );
  const [currentIdx, setCurrentIdx] = useState<number>(
    Math.min(initialPosition.sentenceIdx, Math.max(0, sentenceCount - 1)),
  );
  // `playing` is **user intent**: true = the user wants audio to be
  // emitting samples. Whether the audio element is *actually* playing
  // right now is tracked separately as `audioReady` (false during
  // load/buffer). The `onCanPlay` handler reconciles: if intent is set
  // and the element is paused-but-ready, it calls play(). This means
  // clicking Play during a voice swap or sentence skip stays "armed"
  // and fires automatically once the new src is ready, instead of
  // requiring the user to click again.
  const [playing, setPlaying] = useState(false);
  const playingRef = useRef(false);
  const [audioReady, setAudioReady] = useState(false);
  const [voiceId, setVoiceId] = useState(initialVoiceId);
  const [speed, setSpeed] = useState(clampSpeed(initialSpeed));
  const [alert, setAlert] = useState<AlertState>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  // Audio progress for word-level highlighting on the active sentence.
  // We don't have real word timings from Kokoro, so we approximate by
  // splitting `current_time / duration * word_count`. Close enough for
  // a "you are here" cue at normal speech rates; doesn't pretend to be
  // sub-syllable accurate.
  const [audioCurrentTime, setAudioCurrentTime] = useState(0);
  const [audioDuration, setAudioDuration] = useState(0);
  // Per-idx retry counter so a single dropped chunk doesn't immediately
  // strand playback. Cleared on idx change.
  const retryCountRef = useRef<Map<number, number>>(new Map());

  // Browser-side TTS state. The picker resolves the backend once on
  // mount; if it's "webgpu" or "wasm" we eagerly start the worker so
  // the model download is in flight before the user hits a cache miss.
  const [kokoroBackend, setKokoroBackend] = useState<KokoroBackend | null>(
    () => getCachedBackend(),
  );
  const [kokoroState, setKokoroState] = useState<ClientState>("idle");
  const [kokoroProgress, setKokoroProgress] = useState<LoadProgress | null>(
    null,
  );

  useEffect(() => {
    let cancelled = false;
    void pickKokoroBackend().then((picked) => {
      if (!cancelled) setKokoroBackend(picked);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (kokoroBackend !== "webgpu" && kokoroBackend !== "wasm") return;
    const client = getClient(kokoroBackend);
    setKokoroState(client.state === "idle" ? "loading" : client.state);
    const unsubscribe = client.onProgress((p) => {
      setKokoroProgress(p);
      if (p.stage === "ready") setKokoroState("ready");
    });
    void client
      .init()
      .then(() => setKokoroState("ready"))
      .catch((err) => {
        console.warn("[reader] kokoro client init failed", err);
        setKokoroState("error");
      });
    return () => {
      unsubscribe();
    };
  }, [kokoroBackend]);

  useEffect(() => {
    playingRef.current = playing;
  }, [playing]);

  // Stable lookup for sentences by idx.
  const sentencesByIdx = useMemo(() => {
    const m = new Map<number, ReaderSentence>();
    for (const s of sentences) m.set(s.idx, s);
    return m;
  }, [sentences]);

  const maxLoadedIdx = useMemo(() => {
    if (sentences.length === 0) return -1;
    return sentences[sentences.length - 1].idx;
  }, [sentences]);

  // Measured per-sentence durations, populated as each sentence's audio
  // element fires `loadedmetadata`. Used by the virtual timeline so the
  // already-played portion of the book has accurate cumulative time on
  // the lock-screen scrubber. Sentences not yet measured fall back to
  // a character-count estimate.
  const measuredDurationsRef = useRef<Map<number, number>>(new Map());
  const [measuredDurationsVersion, setMeasuredDurationsVersion] = useState(0);

  // Page-boundary index: page → first idx of that page (within loaded
  // sentences). Built once per sentence-set change. Used by goNextPage
  // and goPrevPage. If a page boundary isn't loaded yet, the navigation
  // primitive falls back to a sentence-level approximation.
  const pageFirstIdx = useMemo(() => {
    const m = new Map<number, number>();
    for (const s of sentences) {
      const existing = m.get(s.page);
      if (existing === undefined || s.idx < existing) m.set(s.page, s.idx);
    }
    return m;
  }, [sentences]);

  // Virtual timeline: cumulative seconds per sentence, totaling to the
  // full estimated book length. This is what MediaSession uses to draw
  // the lock-screen / CarPlay scrubber. Without it, the OS thinks the
  // "track" is one short sentence and seekforward(15s) clamps to a
  // no-op. See lib/sentence-timeline.ts for the math.
  const timeline = useMemo(() => {
    const loaded = new Map<number, { text: string }>();
    for (const s of sentences) loaded.set(s.idx, { text: s.text });
    return buildTimeline({
      sentenceCount,
      loadedSentences: loaded,
      measuredDurations: measuredDurationsRef.current,
      speed,
    });
    // measuredDurationsVersion forces rebuild when refs mutate; sentences
    // captured via the loaded Map closure above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sentenceCount, sentencesByIdx, speed, measuredDurationsVersion]);

  const currentSentence = sentencesByIdx.get(currentIdx) ?? null;

  // Pre-tokenize the active sentence once per text change. The render
  // loop runs on every timeupdate (~4-15 Hz); without this memo the
  // wordPositions array was rebuilt and indexOf-scanned on every tick,
  // which is O(tokens × words) per tick.
  const currentSentenceTokens = useMemo<SentenceTokens | null>(() => {
    if (!currentSentence) return null;
    return tokenizeSentence(currentSentence.text);
  }, [currentSentence]);

  // ---------------------------------------------------------------------
  // Sentence pagination
  // ---------------------------------------------------------------------

  const loadMoreSentences = useCallback(
    async (from: number) => {
      if (loadingMore) return;
      if (from >= sentenceCount) return;
      setLoadingMore(true);
      rum.timing.start("sentences_page");
      try {
        const res = await fetch(
          `/api/books/${bookId}/sentences-page?from=${from}&limit=${PAGE_FETCH_LIMIT}`,
        );
        if (!res.ok) {
          rum.timing.end("sentences_page", { status: res.status, ok: false });
          console.error("[reader] sentences-page failed", res.status);
          return;
        }
        const body = (await res.json()) as { sentences: ReaderSentence[] };
        rum.timing.end("sentences_page", { status: 200, count: body.sentences.length });
        if (body.sentences.length === 0) return;
        setSentences((prev) => {
          const seen = new Set(prev.map((s) => s.idx));
          const additions = body.sentences.filter((s) => !seen.has(s.idx));
          if (additions.length === 0) return prev;
          const merged = [...prev, ...additions];
          merged.sort((a, b) => a.idx - b.idx);
          return merged;
        });
      } catch (err) {
        rum.timing.cancel("sentences_page");
        console.error("[reader] sentences-page error", err);
      } finally {
        setLoadingMore(false);
      }
    },
    [bookId, loadingMore, sentenceCount],
  );

  // Fetch more when current idx is within PAGE_FETCH_THRESHOLD of the last
  // loaded sentence and there are more in the book.
  useEffect(() => {
    if (sentenceCount <= 0) return;
    if (maxLoadedIdx >= sentenceCount - 1) return;
    if (currentIdx + PAGE_FETCH_THRESHOLD < maxLoadedIdx) return;
    void loadMoreSentences(maxLoadedIdx + 1);
  }, [currentIdx, maxLoadedIdx, sentenceCount, loadMoreSentences]);

  // ---------------------------------------------------------------------
  // Audio control
  // ---------------------------------------------------------------------

  // Set the audio src for the current idx + voice + speed. The URL now
  // includes voice and speed so the browser HTTP cache keys correctly.
  //
  // We deliberately do NOT call `audio.play()` here. Calling play()
  // before the new resource has loaded races on iOS and can desync the
  // intent state. Instead, the `onCanPlay` handler below fires play()
  // when the audio element is actually ready, observing the latest
  // intent via `playingRef`.
  // Track any blob: URL we minted from a browser-side synth so we can
  // revoke it once the audio element moves on. Leaking blob URLs in a
  // long reading session would steadily inflate the tab's memory.
  const activeBlobUrlRef = useRef<string | null>(null);
  const releaseActiveBlob = useCallback(() => {
    const url = activeBlobUrlRef.current;
    if (url) {
      URL.revokeObjectURL(url);
      activeBlobUrlRef.current = null;
    }
  }, []);

  // Pending smart-pacing timer. The auto-advance path may defer the
  // play() of a freshly-loaded next sentence so the listener perceives
  // a pause. Cleared whenever the active sentence changes for any
  // reason other than the auto-advance that scheduled it — manual
  // skip, voice/speed change, alert-driven reload, unmount.
  const pacingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearPacingTimer = useCallback(() => {
    if (pacingTimerRef.current) {
      clearTimeout(pacingTimerRef.current);
      pacingTimerRef.current = null;
    }
  }, []);

  // iOS Safari requires audio.play() to chain off a synchronous user
  // gesture. The src-change effect below `awaits fetchAudio` (a network
  // probe), which breaks the gesture chain — by the time canplay fires,
  // iOS treats the play() as autoplay and rejects with NotAllowedError.
  // To preserve the chain, goNext/goPrev set src + load() + play()
  // synchronously inside the click handler and stash the idx here. The
  // effect sees a match and skips its async path. Voice/speed changes
  // invalidate the stash (effect below) so they re-route the new
  // sentence URL through fetchAudio as usual.
  const lastSkipIdxRef = useRef<number | null>(null);
  useEffect(() => {
    lastSkipIdxRef.current = null;
  }, [bookId, voiceId, speed]);

  // True while we're programmatically swapping audio.src. The HTML
  // spec's load() algorithm fires a `pause` event if the element was
  // playing — without this flag, the audio-event sync handlers below
  // would interpret that as a system-initiated pause and clear the
  // play intent mid-transition, killing every auto-advance and skip.
  // Cleared once `canplay` fires (resource ready, any later pause is
  // user/system meaningful).
  const internalTransitionRef = useRef(false);

  useEffect(() => {
    const audio = getActiveAudio();
    if (!audio) return;
    if (!Number.isFinite(currentIdx) || currentIdx < 0) return;

    if (lastSkipIdxRef.current === currentIdx) {
      // goNext/goPrev already set src + load() + play() synchronously
      // for this idx; skip the async fetchAudio path so we don't
      // double-load and trample the gesture-driven play().
      lastSkipIdxRef.current = null;
      retryCountRef.current.delete(currentIdx);
      return;
    }

    // A manual seek (clicking a sentence row, etc.) takes precedence
    // over any pending smart-pacing delay from a prior auto-advance.
    clearPacingTimer();

    setAudioReady(false);
    setAudioCurrentTime(0);
    setAudioDuration(0);
    // New idx → reset its retry counter (a fresh attempt for a brand-new
    // sentence shouldn't inherit a previous one's strikes).
    retryCountRef.current.delete(currentIdx);

    const sentence = sentencesByIdx.get(currentIdx);
    const text = sentence?.text ?? "";
    const controller = new AbortController();
    let cancelled = false;

    void (async () => {
      let url: string;
      let source: "server-cache" | "server-synth" | "browser" = "server-synth";
      try {
        const ref = await fetchAudio({
          bookId,
          idx: currentIdx,
          text,
          voice: voiceId,
          speed,
          signal: controller.signal,
        });
        url = ref.url;
        source = ref.source;
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") return;
        // Resolver shouldn't throw, but if it does the safe move is
        // exactly what we used to do: point at the server URL and let
        // the audio element error path handle the rest.
        console.warn("[reader] fetchAudio failed; using server URL", err);
        url = ttsUrl(bookId, currentIdx, voiceId, speed);
      }
      if (cancelled) {
        if (source === "browser") URL.revokeObjectURL(url);
        return;
      }
      // Replace any blob URL from the previous sentence before
      // installing the new src.
      releaseActiveBlob();
      if (source === "browser") {
        activeBlobUrlRef.current = url;
      }
      internalTransitionRef.current = true;
      audio.src = url;
      audio.load();
    })();

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [bookId, currentIdx, voiceId, speed, sentencesByIdx, releaseActiveBlob]);

  useEffect(() => {
    return () => {
      releaseActiveBlob();
      clearPacingTimer();
    };
  }, [releaseActiveBlob, clearPacingTimer]);

  // Idle-aware auto-scroll. The active sentence gets centered, but only
  // if the user hasn't scrolled the list themselves within the last 5s.
  // This keeps reading-along smooth without yanking the viewport while
  // the user is actively scrolling to skim ahead or look back.
  const programmaticScrollRef = useRef(false);
  const lastUserScrollRef = useRef(0);
  const autoAlignTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const alignNow = useCallback(() => {
    const el = itemRefs.current.get(currentIdx);
    if (!el) return;
    programmaticScrollRef.current = true;
    el.scrollIntoView({ block: "center", behavior: "smooth" });
    // Smooth scroll fires its own scroll events; suppress the handler
    // for ~800ms so the programmatic scroll doesn't reset the idle
    // timer and start a feedback loop.
    setTimeout(() => {
      programmaticScrollRef.current = false;
    }, 800);
  }, [currentIdx]);

  useEffect(() => {
    if (autoAlignTimerRef.current) {
      clearTimeout(autoAlignTimerRef.current);
      autoAlignTimerRef.current = null;
    }
    const idleMs = Date.now() - lastUserScrollRef.current;
    if (idleMs >= IDLE_AUTO_SCROLL_MS) {
      alignNow();
    } else {
      autoAlignTimerRef.current = setTimeout(
        alignNow,
        IDLE_AUTO_SCROLL_MS - idleMs,
      );
    }
    return () => {
      if (autoAlignTimerRef.current) clearTimeout(autoAlignTimerRef.current);
    };
  }, [currentIdx, alignNow]);

  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const onScroll = () => {
      if (programmaticScrollRef.current) return;
      lastUserScrollRef.current = Date.now();
      // Re-arm the auto-align timer so it fires 5s after the user
      // stops scrolling, regardless of whether currentIdx changes.
      if (autoAlignTimerRef.current) clearTimeout(autoAlignTimerRef.current);
      autoAlignTimerRef.current = setTimeout(alignNow, IDLE_AUTO_SCROLL_MS);
    };
    list.addEventListener("scroll", onScroll, { passive: true });
    return () => list.removeEventListener("scroll", onScroll);
  }, [alignNow]);

  // Tab-visibility tracker. Hidden tabs don't get prefetch — a friend
  // leaving the reader open in a background tab while audio drains
  // through the speakers would otherwise pull GPU on every sentence
  // transition for hours. The current sentence still plays from the
  // already-fetched cache; only the lookahead is paused. When the tab
  // is brought back, the dependency change re-runs the effect and the
  // next-idx prefetch fires.
  const [docVisible, setDocVisible] = useState(true);
  useEffect(() => {
    if (typeof document === "undefined") return;
    setDocVisible(document.visibilityState !== "hidden");
    const onChange = () => {
      setDocVisible(document.visibilityState !== "hidden");
    };
    document.addEventListener("visibilitychange", onChange);
    return () => document.removeEventListener("visibilitychange", onChange);
  }, []);

  // Warm the cache for the *next two* sentences (currentIdx + 1, +2) so
  // the auto-advance is a cache hit and the sentence after that is
  // already on its way before the user finishes the current one. Four
  // rules:
  //   1. Only when `audioReady` is true — the active synth has finished
  //      its initial buffer and kokoro is idle.
  //   2. Only when the tab is visible — see the visibility tracker
  //      above.
  //   3. Debounced — if the user is rapid-clicking Next/Prev, every
  //      click would otherwise queue a fresh kokoro job and saturate
  //      the pod. With PREFETCH_DEBOUNCE_MS the user has to "settle"
  //      on a sentence before we warm the ones after it.
  //   4. Aborted on cleanup — if currentIdx changes again, abort any
  //      in-flight prefetches so kokoro doesn't keep working on the
  //      now-stale guesses. Each prefetched idx gets its own
  //      AbortController so they can be cancelled independently as
  //      the active idx advances.
  const prefetchControllersRef = useRef<Map<number, AbortController>>(
    new Map(),
  );
  useEffect(() => {
    if (sentenceCount <= 0) return;
    if (!audioReady) return;
    if (!docVisible) return;
    const targets: number[] = [];
    for (const offset of [1, 2]) {
      const next = currentIdx + offset;
      if (next >= 0 && next < sentenceCount) targets.push(next);
    }
    if (targets.length === 0) return;
    const controllers = prefetchControllersRef.current;
    const t = setTimeout(() => {
      for (const idx of targets) {
        // If we already fired for this idx (e.g. the previous tick's
        // controller hasn't been aborted yet because nothing changed),
        // skip — the browser HTTP cache will still serve the in-flight
        // response, and we don't want a duplicate POST hitting kokoro.
        if (controllers.has(idx)) continue;
        const controller = new AbortController();
        controllers.set(idx, controller);
        rum.event("prefetch_fired", { outcome: "fired", offset: idx - currentIdx });
        void fetch(ttsUrl(bookId, idx, voiceId, speed), {
          cache: "force-cache",
          signal: controller.signal,
        })
          .catch(() => {})
          .finally(() => {
            // Drop the entry once the request settles so a future
            // prefetch for the same idx (e.g. user backed up and
            // returned) can re-issue.
            if (controllers.get(idx) === controller) {
              controllers.delete(idx);
            }
          });
      }
    }, PREFETCH_DEBOUNCE_MS);
    return () => {
      clearTimeout(t);
      // Abort and clear every in-flight prefetch — currentIdx (or
      // voice/speed) is changing, so previously queued targets are now
      // stale. The next effect run will re-issue for the new active idx.
      for (const [idx, controller] of controllers) {
        controller.abort();
        controllers.delete(idx);
      }
    };
  }, [bookId, voiceId, speed, currentIdx, sentenceCount, audioReady, docVisible]);

  // Double-buffer preload: load currentIdx+1 into the inactive audio
  // element so the auto-advance fast path can swap which element is
  // active without going through a load() teardown. Triggered once
  // the current sentence is settled (audioReady) so kokoro isn't
  // saturated during the active sentence's first-play synth.
  //
  // Invariant: preloadIdxRef === currentIdx+1 when the inactive
  // element's src points at the corresponding audio URL. Reset when
  // voice/speed/book changes (preloaded bytes are wrong-voice).
  useEffect(() => {
    if (!audioReady) return;
    if (sentenceCount <= 0) return;
    const targetIdx = currentIdx + 1;
    if (targetIdx >= sentenceCount) {
      // No next sentence to preload; clear so a fast-path attempt
      // doesn't think a stale preload is valid.
      preloadIdxRef.current = null;
      return;
    }
    if (preloadIdxRef.current === targetIdx) return;

    const inactive = getInactiveAudio();
    if (!inactive) return;

    // Set src + load. Won't autoplay because we don't call play().
    // Events fire on this element but `onlyActive` drops them so they
    // don't disrupt active playback state.
    inactive.src = ttsUrl(bookId, targetIdx, voiceId, speed);
    inactive.load();
    preloadIdxRef.current = targetIdx;
    rum.event("audio_preload_issued", { idx: targetIdx });
  }, [
    bookId,
    voiceId,
    speed,
    currentIdx,
    sentenceCount,
    audioReady,
    getInactiveAudio,
  ]);

  // Invalidate preload on voice/speed/book change — the inactive
  // element's src is for a stale (voice, speed) tuple.
  useEffect(() => {
    preloadIdxRef.current = null;
    const inactive = getInactiveAudio();
    if (inactive) {
      // Clearing src forces a load() teardown of the stale buffer.
      // Empty string is the spec-defined "no resource" value.
      inactive.removeAttribute("src");
      try {
        inactive.load();
      } catch {
        // Some browsers throw when load() is called on an element
        // with no src; ignore.
      }
    }
  }, [bookId, voiceId, speed, getInactiveAudio]);

  // The single transition path used by everything that swaps the
  // active sentence: user Next/Prev, MediaSession Next/Prev, audio
  // `ended` auto-advance, and the synth-failed auto-skip. The whole
  // body runs synchronously inside the calling event handler so that:
  //
  //   - On iOS, audio.play() is allowed. CarPlay and the lock screen
  //     keep the audio session alive across the src swap because
  //     play() fires inside either a user gesture or the live `ended`
  //     handler — both of which iOS treats as continuation of the
  //     same MediaSession. An async fetchAudio in between would break
  //     this and iOS would reject the eventual play() as autoplay,
  //     stranding playback (the original "stops as if pause was
  //     pressed" symptom on auto-advance).
  //
  //   - lastSkipIdxRef is stamped so the src-change effect (driven by
  //     the currentIdx state update below) doesn't double-load via
  //     fetchAudio and trample the play() we just issued.
  //
  // Boundary checks (idx < 0, idx >= sentenceCount) are the caller's
  // responsibility — handleEnded handles end-of-book, goPrev/goNext
  // handle their own edges.
  const advanceToIdx = useCallback(
    (nextIdx: number, startPlayback: boolean, playDelayMs = 0) => {
      clearPacingTimer();

      // Fast path: if the inactive element already has the next idx
      // preloaded and decoded, swap which element is active rather
      // than tearing down and reloading. This is the gapless path —
      // no load(), no decode wait, just a flip of which element drives
      // playback.
      const oldKey = activeAudioKeyRef.current;
      const newKey: "A" | "B" = oldKey === "A" ? "B" : "A";
      const newEl = newKey === "A" ? audioRefA.current : audioRefB.current;
      const oldEl = oldKey === "A" ? audioRefA.current : audioRefB.current;
      const canSwap =
        preloadIdxRef.current === nextIdx &&
        newEl !== null &&
        // HAVE_FUTURE_DATA — at least one decoded frame ahead of
        // currentTime; play() can start without buffering.
        newEl.readyState >= 3;

      if (canSwap && newEl) {
        // Flip activeKey *before* touching either element's playback
        // so the `onlyActive` event guard treats events from the
        // formerly-active element as inactive (and ignores them).
        activeAudioKeyRef.current = newKey;
        setActiveAudioKey(newKey);
        preloadIdxRef.current = null;

        if (oldEl) oldEl.pause();

        const dur = Number.isFinite(newEl.duration) ? newEl.duration : 0;
        setAudioCurrentTime(0);
        setAudioDuration(dur);
        setAudioReady(true);
        setCurrentIdx(nextIdx);
        // Suppress the src-change effect so it doesn't reload the
        // already-loaded swap target.
        lastSkipIdxRef.current = nextIdx;

        if (startPlayback) {
          newEl.currentTime = 0;
          if (playDelayMs > 0) {
            newEl.pause();
            pacingTimerRef.current = setTimeout(() => {
              pacingTimerRef.current = null;
              const a = getActiveAudio();
              if (!a || !playingRef.current) return;
              void a.play().catch(() => {});
            }, playDelayMs);
          } else {
            void newEl.play().catch(() => {});
          }
          setPlaying(true);
        }
        return;
      }

      // Slow path: load the next sentence on the active element.
      // Used for manual seeks, voice/speed changes, or when the
      // preload hasn't caught up.
      const audio = getActiveAudio();
      if (audio) {
        // Free any blob URL from the previous sentence; this path
        // always uses the server URL.
        releaseActiveBlob();
        internalTransitionRef.current = true;
        audio.src = ttsUrl(bookId, nextIdx, voiceId, speed);
        audio.load();
        if (startPlayback) {
          if (playDelayMs > 0) {
            // Smart pacing: defer the play() by `playDelayMs` so the
            // listener perceives a pause between sentences. iOS keeps
            // the audio session alive for short delays inside the
            // active reading flow; we cap at 1500ms in smart-pacing.ts
            // to stay within that envelope. If play() still rejects,
            // canplay's intent-driven retry rescues us.
            audio.pause();
            pacingTimerRef.current = setTimeout(() => {
              pacingTimerRef.current = null;
              const a = getActiveAudio();
              if (!a) return;
              if (!playingRef.current) return;
              void a.play().catch(() => {});
            }, playDelayMs);
          } else {
            void audio.play().catch(() => {
              // canplay's retry will pick up via playingRef. If iOS
              // still blocks, the user re-taps to recover — same
              // fallback as the initial-page-load case.
            });
          }
        }
        lastSkipIdxRef.current = nextIdx;
      }
      setAudioReady(false);
      setAudioCurrentTime(0);
      setAudioDuration(0);
      setCurrentIdx(nextIdx);
      if (startPlayback) setPlaying(true);
    },
    [
      bookId,
      voiceId,
      speed,
      releaseActiveBlob,
      clearPacingTimer,
      getActiveAudio,
    ],
  );

  const handleEnded = useCallback(() => {
    rum.event("audio_ended");
    sentencesPlayedRef.current += 1;
    const next = currentIdx + 1;
    if (next >= sentenceCount) {
      setPlaying(false);
      setAlert({ kind: "end-of-book" });
      return;
    }
    // Smart pacing: compute additional silence between this sentence
    // and the next based on punctuation + page/chapter boundary
    // signals. The src + load happens synchronously here so iOS keeps
    // the audio session alive across the swap; only play() may be
    // deferred (advanceToIdx handles the timer dance).
    const ended = sentencesByIdx.get(currentIdx);
    const nextSentence = sentencesByIdx.get(next);
    const nextIsChapterStart = chaptersByStartIdx.some(
      (c) => c.startSentenceIdx === next,
    );
    const pacing = ended
      ? computeInterSentencePauseMs({
          endedText: ended.text,
          endedPage: ended.page,
          nextPage: nextSentence?.page,
          nextIsChapterStart,
        })
      : 0;
    advanceToIdx(next, true, pacing);
  }, [currentIdx, sentenceCount, advanceToIdx, sentencesByIdx, chaptersByStartIdx]);

  // canplay: the audio element has enough buffered to start playing.
  // If the user wants playback (intent), kick it off now. Survives
  // every src change (voice/speed/idx) so playback resumes
  // automatically without the user re-tapping Play.
  const handleCanPlay = useCallback(() => {
    // Resource is ready — any subsequent `pause` event is a real
    // user/system pause rather than a load() side-effect.
    internalTransitionRef.current = false;
    setAudioReady(true);
    rum.event("audio_can_play");
    rum.timing.start("can_play_to_audible");
    const audio = getActiveAudio();
    if (!audio) return;
    if (playingRef.current && audio.paused) {
      void audio.play().catch((err) => {
        const name =
          err instanceof Error && typeof err.name === "string" ? err.name : "";
        if (name === "NotAllowedError") {
          // Browser blocked autoplay (e.g. user opened the page and
          // never tapped). Surface the pause state so the next tap
          // re-arms the user gesture chain.
          setPlaying(false);
        }
        // AbortError just means another play() superseded this one;
        // don't change intent.
      });
    }
  }, []);

  // Funnel: cumulative-play tracking. cumulativePlayMs is the total
  // wall-time the audio has been emitting samples in this session. We
  // tick it on each timeupdate while playing, and emit one-shot funnel
  // events once it crosses 30s (engaged) or on pagehide (session_end).
  const readStartedRef = useRef(false);
  const engagedRef = useRef(false);
  const cumulativePlayMsRef = useRef(0);
  const sentencesPlayedRef = useRef(0);
  const lastTickTsRef = useRef<number | null>(null);

  const handleAudioPlaying = useCallback(() => {
    setAudioReady(true);
    // The play-to-audible timer was opened in togglePlay (or on a
    // src-change while intent is set). Closing it here records the
    // perceived latency from user click → audible audio.
    if (rum.timing.isOpen("play_to_audible")) {
      rum.timing.end("play_to_audible");
    }
    if (rum.timing.isOpen("can_play_to_audible")) {
      const ms = rum.timing.end("can_play_to_audible");
      rum.event("audio_playing", ms !== null ? { canPlayToAudibleMs: ms } : undefined);
    } else {
      rum.event("audio_playing");
    }
    if (!readStartedRef.current) {
      readStartedRef.current = true;
      rum.event("read_started", { voice: voiceId, speed });
    }
    lastTickTsRef.current = Date.now();
  }, [voiceId, speed]);

  const handleAudioWaiting = useCallback(() => {
    setAudioReady(false);
  }, []);

  const handleAudioLoadStart = useCallback(() => {
    setAudioReady(false);
  }, []);

  const handleAudioTimeUpdate = useCallback(() => {
    const audio = getActiveAudio();
    if (!audio) return;
    setAudioCurrentTime(audio.currentTime);
    // Tick the cumulative-play counter. timeupdate fires ~4-15 Hz while
    // the audio is emitting, never while paused — so deltas between
    // ticks are real playback wall-time, not idle UI time.
    if (!audio.paused && lastTickTsRef.current !== null) {
      const now = Date.now();
      const delta = now - lastTickTsRef.current;
      // Cap per-tick delta at 1s so a tab that was throttled in the
      // background doesn't dump a multi-minute jump into the counter
      // when it resumes.
      cumulativePlayMsRef.current += Math.min(delta, 1000);
      lastTickTsRef.current = now;
      if (
        !engagedRef.current &&
        cumulativePlayMsRef.current >= 30_000
      ) {
        engagedRef.current = true;
        rum.event("read_engaged_30s", {
          ms: cumulativePlayMsRef.current,
          last_idx: currentIdx,
        });
      }
    }
  }, [currentIdx]);

  const handleAudioMetadata = useCallback(() => {
    const audio = getActiveAudio();
    if (!audio) return;
    if (!Number.isFinite(audio.duration)) return;
    setAudioDuration(audio.duration);
    // Record the measured duration for the active sentence so the
    // virtual timeline gets more accurate as the user listens. Only
    // bump the version when the measurement actually changes — avoids
    // recomputing the timeline on every pause/play.
    const prev = measuredDurationsRef.current.get(currentIdx);
    if (prev === undefined || Math.abs(prev - audio.duration) > 0.05) {
      measuredDurationsRef.current.set(currentIdx, audio.duration);
      setMeasuredDurationsVersion((v) => v + 1);
    }
  }, [currentIdx]);

  // Mirror the audio element's actual play/pause state into React
  // intent so the OS-driven surface (CarPlay, lock screen, Bluetooth
  // headset) shows the right thing when iOS pauses or resumes us
  // outside our control: incoming call, Siri, headphone unplug,
  // sibling-app preempt, AVAudioSession interruption end. Without
  // this sync, MediaSession reports stale "playing" while audio is
  // silent, and the next press on CarPlay can be a no-op.
  //
  // The `internalTransitionRef` gate skips the spec-mandated `pause`
  // event that load() fires during programmatic src swaps — those
  // are part of an in-flight transition, not a user/system pause.
  const handleAudioPauseEvent = useCallback(() => {
    if (internalTransitionRef.current) return;
    setPlaying(false);
    // Stamp the pause for smart-rewind. Real user/system pause only —
    // the internalTransition gate above filters out the spec-mandated
    // pause event load() fires during programmatic src swaps.
    pausedAtRef.current = Date.now();
  }, []);

  const handleAudioPlayEvent = useCallback(() => {
    setPlaying(true);
  }, []);

  // ---------------------------------------------------------------------
  // Sleep timer
  // ---------------------------------------------------------------------

  const startSleepTimer = useCallback((minutes: number) => {
    if (!Number.isFinite(minutes) || minutes <= 0) return;
    const expiresAt = Date.now() + minutes * 60_000;
    sleepPreFadeVolumeRef.current = getActiveAudio()?.volume ?? 1;
    setSleepMode({ kind: "duration", expiresAt });
    setSleepRemainingMs(expiresAt - Date.now());
    rum.event("sleep_timer_started", { minutes });
  }, []);

  const startEndOfPageTimer = useCallback(() => {
    const current = sentencesByIdx.get(currentIdx);
    if (!current) return;
    sleepPreFadeVolumeRef.current = getActiveAudio()?.volume ?? 1;
    setSleepMode({ kind: "end-of-page", setOnPage: current.page });
    setSleepRemainingMs(null);
    rum.event("sleep_timer_started", { mode: "end-of-page", page: current.page });
  }, [currentIdx, sentencesByIdx]);

  const cancelSleepTimer = useCallback(() => {
    setSleepMode({ kind: "off" });
    setSleepRemainingMs(null);
    const audio = getActiveAudio();
    if (audio) audio.volume = sleepPreFadeVolumeRef.current;
    rum.event("sleep_timer_cancelled");
  }, []);

  const extendSleepTimer = useCallback(() => {
    setSleepMode((prev) => {
      if (prev.kind !== "duration") return prev;
      const next = { ...prev, expiresAt: prev.expiresAt + 5 * 60_000 };
      setSleepRemainingMs(next.expiresAt - Date.now());
      // If we were already inside the fade, restore volume since we now
      // have time again before re-fading.
      const audio = getActiveAudio();
      if (audio) audio.volume = sleepPreFadeVolumeRef.current;
      rum.event("sleep_timer_extended");
      return next;
    });
  }, []);

  // End-of-page watcher: when the active page advances past the page
  // the timer was set on, pause. No fade — the user picked "end of
  // page" precisely so the page finishes naturally.
  useEffect(() => {
    if (sleepMode.kind !== "end-of-page") return;
    const current = sentencesByIdx.get(currentIdx);
    if (!current) return;
    if (current.page <= sleepMode.setOnPage) return;
    const audio = getActiveAudio();
    if (audio) audio.pause();
    setPlaying(false);
    setSleepMode({ kind: "off" });
    rum.event("sleep_timer_expired", { mode: "end-of-page" });
  }, [sleepMode, currentIdx, sentencesByIdx]);

  // 1Hz tick while the timer is running. Drives the volume fade and
  // expires the timer. Stops once mode flips back to "off".
  useEffect(() => {
    if (sleepMode.kind !== "duration") return;
    const tick = () => {
      const audio = getActiveAudio();
      const remaining = sleepMode.expiresAt - Date.now();
      setSleepRemainingMs(Math.max(0, remaining));
      if (audio) {
        if (remaining <= FADE_DURATION_MS && remaining > 0) {
          audio.volume = Math.max(
            0,
            sleepPreFadeVolumeRef.current *
              fadeVolumeForRemaining(remaining),
          );
        }
      }
      if (remaining <= 0) {
        if (audio) {
          audio.pause();
          audio.volume = sleepPreFadeVolumeRef.current;
        }
        setPlaying(false);
        setSleepMode({ kind: "off" });
        setSleepRemainingMs(null);
        rum.event("sleep_timer_expired");
      }
    };
    tick();
    const id = setInterval(tick, 1_000);
    return () => clearInterval(id);
  }, [sleepMode]);

  // ---------------------------------------------------------------------
  // Bookmarks
  // ---------------------------------------------------------------------

  const loadBookmarks = useCallback(async () => {
    try {
      const res = await fetch(`/api/books/${bookId}/bookmarks`);
      if (!res.ok) {
        console.warn("[reader] bookmarks load failed", res.status);
        return;
      }
      const body = (await res.json()) as { bookmarks: BookmarkEntry[] };
      setBookmarks(body.bookmarks);
      setBookmarksLoaded(true);
    } catch (err) {
      console.warn("[reader] bookmarks load error", err);
    }
  }, [bookId]);

  const addBookmarkAtCurrent = useCallback(async () => {
    const idx = currentIdx;
    rum.event("bookmark_created", { idx });
    try {
      const res = await fetch(`/api/books/${bookId}/bookmarks`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sentenceIdx: idx }),
      });
      if (!res.ok) {
        console.warn("[reader] bookmark create failed", res.status);
        return;
      }
      const body = (await res.json()) as { bookmark: BookmarkEntry };
      setBookmarks((prev) => {
        const next = [...prev, body.bookmark];
        next.sort((a, b) => a.sentenceIdx - b.sentenceIdx);
        return next;
      });
      setBookmarksLoaded(true);
    } catch (err) {
      console.warn("[reader] bookmark create error", err);
    }
  }, [bookId, currentIdx]);

  const deleteBookmark = useCallback(
    async (bookmarkId: string) => {
      const prev = bookmarks;
      // Optimistic remove.
      setBookmarks((bs) => bs.filter((b) => b.id !== bookmarkId));
      try {
        const res = await fetch(
          `/api/books/${bookId}/bookmarks/${bookmarkId}`,
          { method: "DELETE" },
        );
        if (!res.ok) {
          console.warn("[reader] bookmark delete failed", res.status);
          setBookmarks(prev); // roll back
        }
      } catch (err) {
        console.warn("[reader] bookmark delete error", err);
        setBookmarks(prev);
      }
    },
    [bookId, bookmarks],
  );

  const updateBookmarkNote = useCallback(
    async (bookmarkId: string, nextNote: string | null) => {
      const prev = bookmarks;
      setBookmarks((bs) =>
        bs.map((b) => (b.id === bookmarkId ? { ...b, note: nextNote } : b)),
      );
      try {
        const res = await fetch(
          `/api/books/${bookId}/bookmarks/${bookmarkId}`,
          {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ note: nextNote }),
          },
        );
        if (!res.ok) {
          console.warn("[reader] bookmark patch failed", res.status);
          setBookmarks(prev);
        }
      } catch (err) {
        console.warn("[reader] bookmark patch error", err);
        setBookmarks(prev);
      }
    },
    [bookId, bookmarks],
  );

  // Open the panel + load on first open.
  const openBookmarks = useCallback(() => {
    setBookmarksOpen(true);
    if (!bookmarksLoaded) void loadBookmarks();
  }, [bookmarksLoaded, loadBookmarks]);

  /** Apply Smart Rewind on resume. Within-sentence clamp only — we
   *  never cross sentence boundaries on rewind so the audio stream
   *  doesn't tear down and re-establish (which would defeat the
   *  purpose: by the time the new sentence loads, the user has lost
   *  more context than we just restored). Audible behaves the same. */
  const applySmartRewindIfNeeded = useCallback(() => {
    const audio = getActiveAudio();
    if (!audio) return;
    const pausedAt = pausedAtRef.current;
    if (pausedAt === null) return;
    pausedAtRef.current = null;
    if (smartRewindSeconds <= 0) return;
    const elapsedMs = Date.now() - pausedAt;
    if (elapsedMs < 30_000) return;
    const before = audio.currentTime;
    const after = Math.max(0, before - smartRewindSeconds);
    if (after >= before) return;
    audio.currentTime = after;
    setAudioCurrentTime(after);
    rum.event("smart_rewind_applied", {
      pausedMs: elapsedMs,
      rewindSeconds: smartRewindSeconds,
      before,
      after,
    });
  }, [smartRewindSeconds]);

  const handleAudioError = useCallback(() => {
    const audio = getActiveAudio();
    if (!audio) return;
    // The browser fires `error` for any non-2xx fetch as well as decode
    // failures. Probe the URL once to learn the real cause.
    void fetch(ttsUrl(bookId, currentIdx, voiceId, speed), { method: "GET" })
      .then(async (res) => {
        // 502/503/504 are all transient: 503 = our route signaling the
        // synth pod is warming, 502 = Caddy or the route can't reach an
        // upstream (e.g. tts-web pod restarting during a deploy), 504 =
        // upstream timeout. Treat them identically — same retry as the
        // service-warming path, so a deploy doesn't surface as
        // "Skipping unreadable sentence".
        if (res.status === 503 || res.status === 502 || res.status === 504) {
          rum.event("audio_error", { kind: "service-warming", status: res.status });
          setAlert({
            kind: "service-warming",
            retryAt: Date.now() + SERVICE_RETRY_MS,
          });
          return;
        }
        if (!res.ok) {
          // Per-idx retry-then-advance. First failure: silently retry
          // load(). Second failure: schedule auto-advance with a
          // user-cancellable countdown.
          const count = (retryCountRef.current.get(currentIdx) ?? 0) + 1;
          retryCountRef.current.set(currentIdx, count);
          if (count <= 1) {
            audio.load();
            setAudioReady(false);
            return;
          }
          rum.event("audio_error", { kind: "synth-failed", status: res.status });
          setAlert({
            kind: "synth-failed",
            idx: currentIdx,
            advanceAt: Date.now() + AUTO_ADVANCE_AFTER_FAIL_MS,
          });
        }
      })
      .catch(() => {
        rum.event("audio_error", { kind: "other" });
        // Network error — treat as service-warming (retry same idx).
        setAlert({
          kind: "service-warming",
          retryAt: Date.now() + SERVICE_RETRY_MS,
        });
      });
  }, [bookId, currentIdx, voiceId, speed]);

  // Stalled: the audio element is fetching but not making progress.
  // Belt-and-suspenders for silent stream drops. After STALL_TIMEOUT_MS
  // without progress we route through the same retry/advance logic as
  // an error.
  const stallTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stallActiveRef = useRef(false);
  const handleAudioStalled = useCallback(() => {
    if (stallTimerRef.current) return;
    if (!stallActiveRef.current) {
      stallActiveRef.current = true;
      rum.event("audio_stall_started");
      rum.timing.start("stall");
    }
    stallTimerRef.current = setTimeout(() => {
      stallTimerRef.current = null;
      const audio = getActiveAudio();
      if (!audio) return;
      if (!playingRef.current) return;
      if (audio.readyState >= 3) return; // HAVE_FUTURE_DATA — playing now
      handleAudioError();
    }, STALL_TIMEOUT_MS);
  }, [handleAudioError]);

  const handleAudioProgress = useCallback(() => {
    if (stallTimerRef.current) {
      clearTimeout(stallTimerRef.current);
      stallTimerRef.current = null;
    }
    if (stallActiveRef.current) {
      stallActiveRef.current = false;
      rum.timing.end("stall");
      rum.event("audio_stall_recovered");
    }
  }, []);

  // Auto-advance for a `synth-failed` alert. User can hit "Cancel" via
  // the alert UI to abort this and keep the alert visible. Reuses the
  // synchronous advance path so when the audio session is still alive
  // (errored mid-stream rather than after a hard tear-down), iOS
  // continues onto the next sentence; if iOS rejects play(), the
  // canplay-driven catch flips intent off as a graceful fallback.
  useEffect(() => {
    if (alert?.kind !== "synth-failed") return;
    const delay = Math.max(0, alert.advanceAt - Date.now());
    const t = setTimeout(() => {
      setAlert(null);
      const next = currentIdx + 1;
      if (next >= sentenceCount) {
        setPlaying(false);
        setAlert({ kind: "end-of-book" });
        return;
      }
      advanceToIdx(next, playing);
    }, delay);
    return () => clearTimeout(t);
  }, [alert, currentIdx, sentenceCount, playing, advanceToIdx]);

  // 503 retry: after SERVICE_RETRY_MS, reload the same idx. Intent
  // (`playing`) is preserved across the alert window, so canplay will
  // restart playback automatically. We only clear the alert here; the
  // canplay handler does the play() call.
  useEffect(() => {
    if (alert?.kind !== "service-warming") return;
    const delay = Math.max(0, alert.retryAt - Date.now());
    const t = setTimeout(() => {
      const audio = getActiveAudio();
      if (!audio) return;
      // Service-warming alerts are about the server backend; route the
      // retry directly at the server URL even if local synth is
      // available. Drop any active blob URL first to avoid leaks.
      releaseActiveBlob();
      internalTransitionRef.current = true;
      audio.src = ttsUrl(bookId, currentIdx, voiceId, speed);
      audio.load();
      setAudioReady(false);
      setAlert(null);
    }, delay);
    return () => clearTimeout(t);
  }, [alert, bookId, currentIdx, voiceId, speed, releaseActiveBlob]);

  // ---------------------------------------------------------------------
  // Position persistence (debounced)
  // ---------------------------------------------------------------------

  const positionTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastSavedIdx = useRef<number>(initialPosition.sentenceIdx);

  const savePositionNow = useCallback(
    (idx: number, useBeacon = false) => {
      if (idx === lastSavedIdx.current) return;
      const body = JSON.stringify({ sentenceIdx: idx, charOffset: 0 });
      const url = `/api/books/${bookId}/position`;
      if (useBeacon && typeof navigator !== "undefined" && navigator.sendBeacon) {
        const blob = new Blob([body], { type: "application/json" });
        // sendBeacon doesn't support PUT; the server route only accepts PUT,
        // so we fall back to a keepalive fetch when sendBeacon isn't viable.
        const ok = navigator.sendBeacon(url, blob);
        if (ok) {
          lastSavedIdx.current = idx;
          return;
        }
      }
      void fetch(url, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body,
        keepalive: true,
      })
        .then((res) => {
          if (res.ok) {
            lastSavedIdx.current = idx;
          } else {
            rum.event("position_save_failed", { status: res.status });
          }
        })
        .catch((err) => {
          rum.event("position_save_failed", { reason: "network" });
          console.warn("[reader] position save failed", err);
        });
    },
    [bookId],
  );

  // Debounced save while playing.
  useEffect(() => {
    if (!playing) return;
    if (positionTimer.current) clearTimeout(positionTimer.current);
    positionTimer.current = setTimeout(() => {
      savePositionNow(currentIdx);
    }, POSITION_DEBOUNCE_MS);
    return () => {
      if (positionTimer.current) clearTimeout(positionTimer.current);
    };
  }, [currentIdx, playing, savePositionNow]);

  // Save on pause/blur/beforeunload. Also emit the funnel-end event
  // on pagehide so the dashboard sees how long the session lasted and
  // how many sentences played.
  useEffect(() => {
    function onUnload() {
      savePositionNow(currentIdx, true);
    }
    function onPagehide() {
      savePositionNow(currentIdx, true);
      if (readStartedRef.current) {
        rum.event("read_session_end", {
          ms: cumulativePlayMsRef.current,
          sentences_played: sentencesPlayedRef.current,
          last_idx: currentIdx,
        });
      }
    }
    function onBlur() {
      savePositionNow(currentIdx);
    }
    window.addEventListener("beforeunload", onUnload);
    window.addEventListener("pagehide", onPagehide);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("beforeunload", onUnload);
      window.removeEventListener("pagehide", onPagehide);
      window.removeEventListener("blur", onBlur);
    };
  }, [currentIdx, savePositionNow]);

  useEffect(() => {
    if (!playing) {
      // Save on transition to paused.
      savePositionNow(currentIdx);
    }
  }, [playing, currentIdx, savePositionNow]);

  // ---------------------------------------------------------------------
  // Controls
  // ---------------------------------------------------------------------

  const togglePlay = useCallback(() => {
    const audio = getActiveAudio();
    if (!audio) return;
    if (playingRef.current) {
      // Pause: drop intent, pause the element. Don't clear `audioReady`
      // — the bytes are still buffered.
      setPlaying(false);
      audio.pause();
      return;
    }
    // Open a play→audible timing mark before any state changes — the
    // mark is closed in handleAudioPlaying once the audio element
    // actually starts emitting samples. Cancel any stale mark first
    // (e.g. user paused before audible and is clicking play again).
    rum.timing.cancel("play_to_audible");
    rum.timing.start("play_to_audible");
    rum.event("play_clicked", { hasSrc: !!audio.src });
    // Play: set intent first so any subsequent canplay/load events
    // see we want playback. Then try to play() inside the user-gesture
    // window — this is what unblocks iOS autoplay.
    setPlaying(true);
    // Pressing Play is an explicit "engage with the content" signal,
    // so jump back to the active sentence immediately rather than
    // waiting on the idle-aware auto-align. Reset the idle timestamp
    // so the next 5s-after-scroll grace starts fresh from here.
    lastUserScrollRef.current = 0;
    alignNow();
    // If the user is resuming after a long pause, rewind a few seconds
    // first so they re-establish context. No-op if pause was short or
    // setting is 0.
    applySmartRewindIfNeeded();
    if (!audio.src) {
      internalTransitionRef.current = true;
      audio.src = ttsUrl(bookId, currentIdx, voiceId, speed);
      audio.load();
      setAudioReady(false);
      // canplay will start playback when the resource is ready.
      return;
    }
    void audio.play().catch((err) => {
      const name =
        err instanceof Error && typeof err.name === "string" ? err.name : "";
      if (name === "NotAllowedError") {
        // Autoplay actually blocked — revert intent so the user can
        // re-tap and re-establish the gesture chain.
        setPlaying(false);
      }
      // AbortError or others: leave intent set; canplay will retry.
    });
  }, [bookId, currentIdx, voiceId, speed, alignNow]);

  const goPrev = useCallback(() => {
    setAlert(null);
    if (currentIdx <= 0) return;
    advanceToIdx(currentIdx - 1, true);
  }, [currentIdx, advanceToIdx]);

  const goNext = useCallback(() => {
    setAlert(null);
    if (currentIdx + 1 >= sentenceCount) return;
    advanceToIdx(currentIdx + 1, true);
  }, [currentIdx, sentenceCount, advanceToIdx]);

  const seekTo = useCallback(
    (idx: number) => {
      if (idx < 0 || idx >= sentenceCount) return;
      setAlert(null);
      // Reset the highlight progress in the same React batch as the idx
      // change so the new sentence's first paint doesn't reuse the old
      // sentence's audioCurrentTime/Duration and highlight a wrong word.
      setAudioCurrentTime(0);
      setAudioDuration(0);
      setCurrentIdx(idx);
      // If user clicks while paused, leave paused; if playing, the src
      // change effect will autoplay.
    },
    [sentenceCount],
  );

  // ---------------------------------------------------------------------
  // Page / chapter / restart navigation
  // ---------------------------------------------------------------------

  // Find the first idx of the page strictly greater than `currentPage`.
  // If we don't have it loaded, fall back to scanning sentences forward
  // from currentIdx — most of the time the next page's sentences are
  // already loaded because the lazy-fetch window is generous (50 ahead).
  const goNextPage = useCallback(() => {
    setAlert(null);
    const current = sentencesByIdx.get(currentIdx);
    if (!current) {
      // No info — fall back to a generous sentence step. Preferable to
      // a no-op, since "Next page" should always do something visible.
      const fallback = Math.min(sentenceCount - 1, currentIdx + 8);
      if (fallback !== currentIdx) advanceToIdx(fallback, playingRef.current);
      return;
    }
    const targetPage = current.page + 1;
    const directHit = pageFirstIdx.get(targetPage);
    if (directHit !== undefined) {
      advanceToIdx(directHit, playingRef.current);
      return;
    }
    // Linear scan over loaded sentences for the first idx whose page
    // exceeds currentPage. Sentences are sorted by idx (we sort on
    // load), so the first match is the page boundary.
    for (const s of sentences) {
      if (s.idx <= currentIdx) continue;
      if (s.page > current.page) {
        advanceToIdx(s.idx, playingRef.current);
        return;
      }
    }
    // Page boundary not in our loaded window. Trigger a fetch and hop
    // to a reasonable approximation in the meantime — the user gets
    // movement now and the load window will catch up.
    void loadMoreSentences(maxLoadedIdx + 1);
    const guess = Math.min(sentenceCount - 1, maxLoadedIdx + 1);
    if (guess !== currentIdx) advanceToIdx(guess, playingRef.current);
  }, [
    sentencesByIdx,
    currentIdx,
    sentenceCount,
    advanceToIdx,
    pageFirstIdx,
    sentences,
    loadMoreSentences,
    maxLoadedIdx,
  ]);

  const goPrevPage = useCallback(() => {
    setAlert(null);
    const current = sentencesByIdx.get(currentIdx);
    if (!current) {
      const fallback = Math.max(0, currentIdx - 8);
      if (fallback !== currentIdx) advanceToIdx(fallback, playingRef.current);
      return;
    }
    // If we're not at the first sentence of our page, "Previous page"
    // first jumps to the start of the current page — Audible-equivalent
    // double-tap-back semantics, but accessible from a single press.
    const startOfCurrent = pageFirstIdx.get(current.page);
    if (startOfCurrent !== undefined && startOfCurrent < currentIdx) {
      advanceToIdx(startOfCurrent, playingRef.current);
      return;
    }
    const targetPage = current.page - 1;
    if (targetPage < 0) return;
    const directHit = pageFirstIdx.get(targetPage);
    if (directHit !== undefined) {
      advanceToIdx(directHit, playingRef.current);
      return;
    }
    // Scan backwards through loaded sentences for the previous page's
    // first idx.
    let lastOnPrev: number | null = null;
    for (const s of sentences) {
      if (s.idx >= currentIdx) break;
      if (s.page === targetPage) {
        if (lastOnPrev === null || s.idx < lastOnPrev) lastOnPrev = s.idx;
      }
    }
    if (lastOnPrev !== null) {
      advanceToIdx(lastOnPrev, playingRef.current);
      return;
    }
    // No prior page in the loaded window — best effort: jump back a chunk.
    const guess = Math.max(0, currentIdx - 8);
    if (guess !== currentIdx) advanceToIdx(guess, playingRef.current);
  }, [
    sentencesByIdx,
    currentIdx,
    advanceToIdx,
    pageFirstIdx,
    sentences,
  ]);

  // Real chapter navigation when the PDF outline yielded chapters.
  // Otherwise fall through to page-level — the "Next chapter" setting
  // still does *something* useful for outline-less PDFs (~40% of
  // self-published / scanned material).
  const goNextChapter = useCallback(() => {
    setAlert(null);
    if (chaptersByStartIdx.length === 0) {
      goNextPage();
      return;
    }
    const target = chaptersByStartIdx.find(
      (c) => c.startSentenceIdx > currentIdx,
    );
    if (target) {
      advanceToIdx(target.startSentenceIdx, playingRef.current);
    }
  }, [chaptersByStartIdx, currentIdx, advanceToIdx, goNextPage]);

  const goPrevChapter = useCallback(() => {
    setAlert(null);
    if (chaptersByStartIdx.length === 0) {
      goPrevPage();
      return;
    }
    // Audible-style: if the user is past the start of the current
    // chapter, "Previous chapter" first jumps to the start of that
    // chapter. A second press jumps to the previous chapter's start.
    let currentChapterStart: number | null = null;
    let prevChapterStart: number | null = null;
    for (const c of chaptersByStartIdx) {
      if (c.startSentenceIdx <= currentIdx) {
        prevChapterStart = currentChapterStart;
        currentChapterStart = c.startSentenceIdx;
      } else {
        break;
      }
    }
    if (
      currentChapterStart !== null &&
      currentChapterStart < currentIdx
    ) {
      advanceToIdx(currentChapterStart, playingRef.current);
      return;
    }
    if (prevChapterStart !== null) {
      advanceToIdx(prevChapterStart, playingRef.current);
      return;
    }
    // Already at or before the first chapter — restart book.
    advanceToIdx(0, playingRef.current);
  }, [chaptersByStartIdx, currentIdx, advanceToIdx, goPrevPage]);

  const restartSentence = useCallback(() => {
    const audio = getActiveAudio();
    if (!audio) return;
    audio.currentTime = 0;
    setAudioCurrentTime(0);
    if (audio.paused && playingRef.current) {
      void audio.play().catch(() => {});
    }
  }, []);

  const restartBook = useCallback(() => {
    setAlert(null);
    advanceToIdx(0, playingRef.current);
  }, [advanceToIdx]);

  /** Seek by `deltaSeconds` along the virtual book timeline. Positive
   *  goes forward, negative back. If the destination falls within the
   *  current sentence, just nudge `audio.currentTime`; if it crosses
   *  into another sentence, advance with autoplay matching current
   *  intent. */
  const seekByVirtualSeconds = useCallback(
    (deltaSeconds: number) => {
      const audio = getActiveAudio();
      if (!audio) return;
      if (!Number.isFinite(deltaSeconds) || deltaSeconds === 0) return;
      const currentVirtual = idxToVirtual(
        currentIdx,
        audio.currentTime,
        timeline,
      );
      const targetVirtual = Math.max(
        0,
        Math.min(timeline.totalDuration, currentVirtual + deltaSeconds),
      );
      const { idx: targetIdx, offsetWithinSentence } = virtualToIdx(
        targetVirtual,
        timeline,
      );
      if (targetIdx === currentIdx) {
        const dur = Number.isFinite(audio.duration) ? audio.duration : null;
        const clamped =
          dur !== null
            ? Math.max(0, Math.min(dur, offsetWithinSentence))
            : Math.max(0, offsetWithinSentence);
        audio.currentTime = clamped;
        return;
      }
      // Cross-sentence seek. Advance with autoplay if intent is set,
      // otherwise leave paused. Best-effort to nudge currentTime to
      // the in-sentence offset once the new sentence is ready —
      // canplay will catch the playback intent; the offset is set in
      // a one-shot loadedmetadata listener.
      const wantOffset = offsetWithinSentence;
      const onMetaOnce = () => {
        const a = getActiveAudio();
        if (!a) return;
        const dur = Number.isFinite(a.duration) ? a.duration : null;
        if (dur !== null && wantOffset > 0) {
          a.currentTime = Math.max(0, Math.min(dur - 0.05, wantOffset));
        }
        a.removeEventListener("loadedmetadata", onMetaOnce);
      };
      audio.addEventListener("loadedmetadata", onMetaOnce, { once: true });
      advanceToIdx(targetIdx, playingRef.current);
    },
    [currentIdx, timeline, advanceToIdx],
  );

  // ---------------------------------------------------------------------
  // Media Session (CarPlay / Android Auto / lock screen)
  // ---------------------------------------------------------------------
  //
  // Wires the W3C Media Session API onto the persistent <audio> element
  // so external surfaces — CarPlay, Android Auto, Bluetooth headsets,
  // OS lock screens, steering-wheel controls — can drive playback. All
  // OS-facing writes live in `useMediaSession`; here we just supply the
  // current metadata, the handlers that translate OS actions into
  // reader intent, and a snapshot of playback position.

  // Latch `enabled` once the audio is ready or the user has hit play.
  // Once true it stays true for the lifetime of the reader — without
  // this, `audioReady` flickering false during a sentence's load gap
  // would tear down and rebuild the OS-level session every ~5s, which
  // re-triggers AVRCP track-change announcements on Bluetooth headsets
  // and re-fetches artwork on CarPlay.
  const [mediaSessionArmed, setMediaSessionArmed] = useState(false);
  useEffect(() => {
    if (!mediaSessionArmed && (audioReady || playing)) {
      setMediaSessionArmed(true);
    }
  }, [mediaSessionArmed, audioReady, playing]);

  // Position state for the OS-level scrubber. Reports the *whole book*
  // as one virtual track — duration is the cumulative timeline total,
  // position is where the listener is in that timeline. This is the
  // critical fix for "CarPlay skip-forward does nothing": when the OS
  // sees a multi-hour duration, seekforward(15s) makes a meaningful
  // jump; when it saw a 5-second per-sentence duration, the same call
  // clamped to ~zero motion.
  //
  // Hold the last finite snapshot across the brief gap where `audioReady`
  // flips false during a sentence src swap. The W3C contract treats null
  // as "clear the scrubber", which iOS lock-screen visibly interprets as
  // a zero-duration track. Stale-by-a-few-hundred-ms is fine; cleared
  // is not.
  const lastPositionStateRef = useRef<MediaSessionPositionState>(null);
  const positionState = useMemo<MediaSessionPositionState>(() => {
    if (timeline.totalDuration > 0) {
      const offsetWithin =
        audioReady && Number.isFinite(audioCurrentTime)
          ? audioCurrentTime
          : 0;
      const virtualPosition = idxToVirtual(currentIdx, offsetWithin, timeline);
      const next: MediaSessionPositionState = {
        duration: timeline.totalDuration,
        position: Math.min(virtualPosition, timeline.totalDuration),
        playbackRate: speed,
      };
      lastPositionStateRef.current = next;
      return next;
    }
    return lastPositionStateRef.current;
  }, [timeline, currentIdx, audioReady, audioCurrentTime, speed]);

  // Dispatcher that maps a configured MediaAction into the right
  // navigation primitive. Created from a stable handler bag so the
  // MediaSession callbacks don't need to re-register on every render.
  const navHandlersRef = useRef<NavigationHandlers>({
    goNextSentence: () => {},
    goPrevSentence: () => {},
    goNextPage: () => {},
    goPrevPage: () => {},
    goNextChapter: () => {},
    goPrevChapter: () => {},
    seekByVirtualSeconds: () => {},
    restartSentence: () => {},
    restartBook: () => {},
  });
  useEffect(() => {
    navHandlersRef.current = {
      goNextSentence: goNext,
      goPrevSentence: goPrev,
      goNextPage,
      goPrevPage,
      goNextChapter,
      goPrevChapter,
      seekByVirtualSeconds,
      restartSentence,
      restartBook,
    };
  }, [
    goNext,
    goPrev,
    goNextPage,
    goPrevPage,
    goNextChapter,
    goPrevChapter,
    seekByVirtualSeconds,
    restartSentence,
    restartBook,
  ]);

  // Lock-screen / CarPlay artwork. Generated from title + author once
  // the reader mounts in the browser; SSR returns null and the metadata
  // simply has no artwork until the client takes over (one paint
  // cycle). Cached inside the generator so reopening the same book is
  // free.
  const [coverArtwork, setCoverArtwork] = useState<MediaImage[] | undefined>(
    undefined,
  );
  useEffect(() => {
    const url = generateCoverArtwork({ title, author });
    if (url) {
      setCoverArtwork([{ src: url, sizes: "512x512", type: "image/png" }]);
    }
  }, [title, author]);

  useMediaSession({
    enabled: mediaSessionArmed,
    // Album is intentionally empty — encoding "Sentence N of M" here
    // re-creates the MediaMetadata every sentence, which Bluetooth
    // headsets and Android Auto interpret as a new track. Sentence
    // progress is surfaced via the scrubber (`positionState`); book
    // progress is intentionally out of scope until a virtual-timeline
    // plays the whole book through one MediaMetadata.
    metadata: {
      title,
      artist: author ?? "",
      album: "",
      artwork: coverArtwork,
    },
    handlers: {
      // Idempotent: don't gate on playingRef. If the audio is already
      // playing, audio.play() is a no-op; if intent had drifted from
      // reality (e.g., after an iOS interruption) the unconditional
      // call brings them back in sync. Gating on stale internal state
      // was the cause of "I press Pause on CarPlay and nothing
      // happens" — now Pause always pauses and Play always plays.
      onPlay: () => {
        const audio = getActiveAudio();
        if (!audio) return;
        rum.timing.cancel("play_to_audible");
        rum.timing.start("play_to_audible");
        rum.event("play_clicked", {
          hasSrc: !!audio.src,
          source: "media-session",
        });
        setPlaying(true);
        // Smart rewind on resume from CarPlay / lock screen too — the
        // user pressed Play after walking away; same intent as in-app
        // resume.
        applySmartRewindIfNeeded();
        void audio.play().catch((err) => {
          const name =
            err instanceof Error && typeof err.name === "string"
              ? err.name
              : "";
          if (name === "NotAllowedError") setPlaying(false);
        });
      },
      onPause: () => {
        const audio = getActiveAudio();
        if (!audio) return;
        audio.pause();
        setPlaying(false);
      },
      onNextTrack: () => {
        rum.event("media_action_fired", {
          action: hardwareControls.nextTrackAction,
          source: "media-session",
          control: "next-track",
        });
        dispatchMediaAction(
          hardwareControls.nextTrackAction,
          navHandlersRef.current,
          { seekStepSeconds: hardwareControls.seekStepSeconds },
        );
      },
      onPreviousTrack: () => {
        // iPod / Audible heuristic: if the user is mid-sentence and
        // their action is the default sentence-step, pressing back
        // restarts the current sentence instead of jumping. This only
        // activates when the user hasn't customized the action — once
        // they pick something else (next page, restart book, …) we
        // honor that explicitly and skip the heuristic.
        const audio = getActiveAudio();
        if (
          hardwareControls.prevTrackAction === "prev_sentence" &&
          audio &&
          audio.currentTime > 3
        ) {
          rum.event("media_action_fired", {
            action: "restart_sentence",
            source: "media-session",
            control: "prev-track",
            via: "ipod-heuristic",
          });
          audio.currentTime = 0;
          if (audio.paused) {
            void audio.play().catch(() => {});
            setPlaying(true);
          }
          return;
        }
        rum.event("media_action_fired", {
          action: hardwareControls.prevTrackAction,
          source: "media-session",
          control: "prev-track",
        });
        dispatchMediaAction(
          hardwareControls.prevTrackAction,
          navHandlersRef.current,
          { seekStepSeconds: hardwareControls.seekStepSeconds },
        );
      },
      onSeekBackward: (offset) => {
        rum.event("media_action_fired", {
          action: hardwareControls.seekBackwardAction,
          source: "media-session",
          control: "seek-backward",
          offset,
        });
        dispatchMediaAction(
          hardwareControls.seekBackwardAction,
          navHandlersRef.current,
          {
            seekStepSeconds: hardwareControls.seekStepSeconds,
            seekOffsetOverride: offset,
          },
        );
      },
      onSeekForward: (offset) => {
        rum.event("media_action_fired", {
          action: hardwareControls.seekForwardAction,
          source: "media-session",
          control: "seek-forward",
          offset,
        });
        dispatchMediaAction(
          hardwareControls.seekForwardAction,
          navHandlersRef.current,
          {
            seekStepSeconds: hardwareControls.seekStepSeconds,
            seekOffsetOverride: offset,
          },
        );
      },
      onSeekTo: (position) => {
        // `position` is virtual book-time because that's what we report
        // in setPositionState. Map back to (idx, offset) and either
        // nudge currentTime within the active sentence or advance.
        if (!Number.isFinite(position)) return;
        rum.event("media_action_fired", {
          action: "seek_to",
          source: "media-session",
          control: "seek-to",
          position,
        });
        const { idx, offsetWithinSentence } = virtualToIdx(position, timeline);
        const audio = getActiveAudio();
        if (idx === currentIdx && audio) {
          const dur = Number.isFinite(audio.duration) ? audio.duration : null;
          audio.currentTime =
            dur !== null
              ? Math.max(0, Math.min(dur, offsetWithinSentence))
              : Math.max(0, offsetWithinSentence);
          return;
        }
        const wantOffset = offsetWithinSentence;
        const onMetaOnce = () => {
          const a = getActiveAudio();
          if (!a) return;
          const dur = Number.isFinite(a.duration) ? a.duration : null;
          if (dur !== null && wantOffset > 0) {
            a.currentTime = Math.max(0, Math.min(dur - 0.05, wantOffset));
          }
          a.removeEventListener("loadedmetadata", onMetaOnce);
        };
        if (audio) {
          audio.addEventListener("loadedmetadata", onMetaOnce, { once: true });
        }
        advanceToIdx(idx, playingRef.current);
      },
      // No `onStop` — passing nothing tells the hook to register null,
      // which hides the Stop button on CarPlay. Stop's expected
      // semantic is "tear down the now-playing surface", not "pause" —
      // and we want users to keep the surface alive between sentences.
    },
    playbackState: playing ? "playing" : audioReady ? "paused" : "none",
    positionState,
  });

  // Trigger a background prerender of the entire book in the current
  // (voice, speed). Fires on mount, on voice change, and on speed
  // change. The server dedupes concurrent calls for the same triple
  // so this is safe to call freely. Once the prerender completes,
  // every sentence in this voice/speed is a hot cache hit and the
  // user never waits for kokoro again — only voice/speed changes
  // against an un-prerendered combination pay real-time synth cost.
  //
  // The /prerender endpoint can return:
  //   - { status: "complete", prerenderedAt } (200) — already done
  //   - { status: "queued" }                  (202) — newly enqueued
  //   - { status: "in_progress" }             (202) — already running
  // We only need to short-circuit on "complete": once the server has
  // confirmed the (book,voice,speed) triple is fully synthesized, every
  // subsequent POST in this session is wasted work. Track confirmed
  // triples in a ref so re-renders don't reset the set.
  const completedPrerendersRef = useRef<Set<string>>(new Set());
  const triggerPrerender = useCallback(
    (voice: string, speedValue: number) => {
      const key = `${bookId}:${voice}:${speedValue.toFixed(2)}`;
      if (completedPrerendersRef.current.has(key)) return;
      rum.event("prerender_triggered", { voice, speed: speedValue });
      void fetch(`/api/books/${encodeURIComponent(bookId)}/prerender`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ voice, speed: speedValue }),
        keepalive: true,
      })
        .then(async (res) => {
          if (!res.ok) return;
          // Only 200 carries `complete`; 202 responses are
          // queued/in_progress and we should keep checking on future
          // mounts in case the user comes back later.
          if (res.status !== 200) return;
          try {
            const body = (await res.json()) as { status?: string };
            if (body?.status === "complete") {
              completedPrerendersRef.current.add(key);
            }
          } catch {
            // Non-JSON or parse failure — leave the key un-cached so
            // we'll retry on the next change.
          }
        })
        .catch(() => {});
    },
    [bookId],
  );

  useEffect(() => {
    triggerPrerender(voiceId, speed);
  }, [triggerPrerender, voiceId, speed]);

  // Web Vitals are now registered globally in app/_components/rum-init.tsx
  // so they fire on every route (landing, login, upload, reader). Each
  // observation carries the templated route as a label.

  // Push settings changes to the server. Accepts any subset of the
  // userSettings columns the API accepts. Best-effort — UI updates
  // optimistically and we don't roll back on failure.
  const persistSettings = useCallback(
    async (patch: Record<string, unknown>) => {
      try {
        const res = await fetch("/api/users/me/settings", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(patch),
        });
        if (!res.ok) {
          console.warn("[reader] settings save failed", res.status);
        }
      } catch (err) {
        console.warn("[reader] settings save error", err);
      }
    },
    [],
  );

  const onVoiceChange = useCallback(
    (next: string) => {
      setVoiceId(next);
      void persistSettings({ voiceId: next });
    },
    [persistSettings],
  );

  const onSpeedChange = useCallback(
    (next: number) => {
      const clamped = clampSpeed(next);
      setSpeed(clamped);
      void persistSettings({ speed: clamped });
    },
    [persistSettings],
  );

  const onHardwareControlsChange = useCallback(
    (patch: Partial<HardwareControlSettings>) => {
      setHardwareControls((prev) => ({ ...prev, ...patch }));
      void persistSettings(patch);
    },
    [persistSettings],
  );

  const onSmartRewindChange = useCallback(
    (seconds: number) => {
      const clamped = Math.max(0, Math.min(60, Math.round(seconds)));
      setSmartRewindSeconds(clamped);
      void persistSettings({ smartRewindSeconds: clamped });
    },
    [persistSettings],
  );

  // ---------------------------------------------------------------------
  // Keyboard
  // ---------------------------------------------------------------------

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      // Skip when the user is typing into a control or focused on a button —
      // Space and ArrowLeft/Right have native semantics on form controls
      // that we don't want to double-fire from the document handler.
      const target = e.target as HTMLElement | null;
      if (target) {
        const tag = target.tagName;
        if (
          tag === "INPUT" ||
          tag === "TEXTAREA" ||
          tag === "SELECT" ||
          tag === "BUTTON" ||
          target.isContentEditable
        ) {
          return;
        }
      }
      if (e.key === " ") {
        e.preventDefault();
        togglePlay();
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        if (e.shiftKey) {
          rum.event("media_action_fired", {
            action: "prev_page",
            source: "keyboard",
          });
          goPrevPage();
        } else {
          goPrev();
        }
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        if (e.shiftKey) {
          rum.event("media_action_fired", {
            action: "next_page",
            source: "keyboard",
          });
          goNextPage();
        } else {
          goNext();
        }
      } else if (e.key === "[") {
        e.preventDefault();
        onSpeedChange(stepSpeed(speed, -1));
      } else if (e.key === "]") {
        e.preventDefault();
        onSpeedChange(stepSpeed(speed, 1));
      } else if (e.key === "r" || e.key === "R") {
        e.preventDefault();
        if (e.shiftKey) {
          // Confirm guard for the destructive reset — pressing this
          // mid-book is rarely intentional.
          if (
            currentIdx > 0 &&
            window.confirm("Restart this book from the beginning?")
          ) {
            rum.event("media_action_fired", {
              action: "restart_book",
              source: "keyboard",
            });
            restartBook();
          }
        } else {
          rum.event("media_action_fired", {
            action: "restart_sentence",
            source: "keyboard",
          });
          restartSentence();
        }
      } else if (e.key === "b" || e.key === "B") {
        e.preventDefault();
        void addBookmarkAtCurrent();
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [
    togglePlay,
    goPrev,
    goNext,
    goPrevPage,
    goNextPage,
    restartSentence,
    restartBook,
    addBookmarkAtCurrent,
    onSpeedChange,
    speed,
    currentIdx,
  ]);

  // ---------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------

  // Active-element guard for audio events. Both <audio> elements share
  // the same handler set; this wraps each handler so that events from
  // the inactive (preload) element are dropped — only the active
  // element's events drive playback state. We don't need to listen to
  // inactive events explicitly: the preload-readiness check at swap
  // time queries `readyState` directly, which is enough.
  const onlyActive = useCallback(
    (handler: () => void) =>
      (e: React.SyntheticEvent<HTMLAudioElement>) => {
        if (e.currentTarget !== getActiveAudio()) return;
        handler();
      },
    [getActiveAudio],
  );

  return (
    <div className="flex flex-col gap-6">
      {/*
        Two audio elements to enable double-buffered playback. Both
        receive the same handlers; `onlyActive` wraps each so events
        from the inactive (preload) element don't drive state. The
        inactive element loads currentIdx+1 ahead of time so the
        auto-advance fast path can swap activeAudioKey instead of
        going through a load() teardown — eliminating the ~50ms
        perceptible gap between sentences. Manual seek (Prev/Next/list
        click) and voice/speed change still take the load() path on
        the active element.
      */}
      <audio
        ref={audioRefA}
        onEnded={onlyActive(handleEnded)}
        onError={onlyActive(handleAudioError)}
        onCanPlay={onlyActive(handleCanPlay)}
        onPlaying={onlyActive(handleAudioPlaying)}
        onPlay={onlyActive(handleAudioPlayEvent)}
        onPause={onlyActive(handleAudioPauseEvent)}
        onWaiting={onlyActive(handleAudioWaiting)}
        onLoadStart={onlyActive(handleAudioLoadStart)}
        onStalled={onlyActive(handleAudioStalled)}
        onProgress={onlyActive(handleAudioProgress)}
        onTimeUpdate={onlyActive(handleAudioTimeUpdate)}
        onLoadedMetadata={onlyActive(handleAudioMetadata)}
        onDurationChange={onlyActive(handleAudioMetadata)}
        preload="auto"
        playsInline
        className="sr-only"
      />
      <audio
        ref={audioRefB}
        onEnded={onlyActive(handleEnded)}
        onError={onlyActive(handleAudioError)}
        onCanPlay={onlyActive(handleCanPlay)}
        onPlaying={onlyActive(handleAudioPlaying)}
        onPlay={onlyActive(handleAudioPlayEvent)}
        onPause={onlyActive(handleAudioPauseEvent)}
        onWaiting={onlyActive(handleAudioWaiting)}
        onLoadStart={onlyActive(handleAudioLoadStart)}
        onStalled={onlyActive(handleAudioStalled)}
        onProgress={onlyActive(handleAudioProgress)}
        onTimeUpdate={onlyActive(handleAudioTimeUpdate)}
        onLoadedMetadata={onlyActive(handleAudioMetadata)}
        onDurationChange={onlyActive(handleAudioMetadata)}
        preload="auto"
        playsInline
        className="sr-only"
      />

      <ol
        ref={listRef}
        className="max-h-[60vh] divide-y divide-border overflow-y-auto rounded-lg border border-border bg-surface"
      >
        {sentences.map((s) => {
          const isCurrent = s.idx === currentIdx;
          // Word-level karaoke highlight, scoped to the active
          // sentence. Other sentences render as plain text.
          const progress =
            isCurrent && audioDuration > 0
              ? audioCurrentTime / audioDuration
              : 0;
          return (
            <li
              key={s.idx}
              ref={(node) => {
                if (node) itemRefs.current.set(s.idx, node);
                else itemRefs.current.delete(s.idx);
              }}
            >
              <button
                type="button"
                onClick={() => seekTo(s.idx)}
                className={`block w-full px-4 py-3 text-left text-sm leading-relaxed transition-colors ${
                  isCurrent
                    ? "bg-surface-2 text-fg"
                    : "text-muted hover:bg-surface-2 hover:text-fg"
                }`}
              >
                <span className="mr-2 text-xs text-subtle tabular-nums">
                  {s.idx + 1}
                </span>
                {isCurrent && currentSentenceTokens
                  ? renderHighlightedSentence(s.text, progress, currentSentenceTokens)
                  : s.text}
              </button>
            </li>
          );
        })}
        {loadingMore ? (
          <li className="px-4 py-3 text-xs text-subtle">Loading more…</li>
        ) : null}
        {sentences.length === 0 ? (
          <li className="px-4 py-6 text-sm text-muted">
            This book has no parsed sentences yet.
          </li>
        ) : null}
      </ol>

      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 px-1 text-xs text-subtle">
        <span className="tabular-nums">
          Sentence {currentIdx + 1} of {sentenceCount}
          {currentSentence ? ` · page ${currentSentence.page}` : ""}
        </span>
        <span className="hidden sm:inline">
          Space play · ← → sentence · ⇧← ⇧→ page · R restart · B bookmark · [ ] speed
        </span>
      </div>

      {alert ? (
        <div className="rounded-md border-l-2 border-danger bg-danger-soft px-3 py-2">
          {alert.kind === "service-warming" ? (
            <p role="alert" className="text-sm text-danger">
              Voice service is starting up, retrying in 5s…
            </p>
          ) : null}
          {alert.kind === "synth-failed" ? (
            <div className="flex items-center justify-between gap-3">
              <p role="alert" className="text-sm text-danger">
                Skipping unreadable sentence in 1.5s…
              </p>
              <button
                type="button"
                onClick={() => setAlert(null)}
                className="text-xs text-fg underline underline-offset-4 hover:text-muted"
              >
                Cancel
              </button>
            </div>
          ) : null}
          {alert.kind === "end-of-book" ? (
            <p role="status" className="text-sm text-muted">
              End of book.
            </p>
          ) : null}
        </div>
      ) : null}

      {kokoroState === "loading" && kokoroProgress ? (
        <div
          role="status"
          aria-live="polite"
          className="flex items-center gap-3 rounded-md border border-border bg-surface px-3 py-2 text-xs text-muted"
        >
          <span className="tabular-nums">
            {kokoroBackend === "webgpu"
              ? "Loading on-device voice (WebGPU)…"
              : "Loading on-device voice…"}
          </span>
          {kokoroProgress.total > 0 ? (
            <span
              aria-hidden="true"
              className="h-1 w-32 overflow-hidden rounded-full bg-surface-2"
            >
              <span
                className="block h-full bg-accent transition-[width] duration-150"
                style={{
                  width: `${Math.min(
                    100,
                    Math.max(
                      0,
                      Math.round(
                        (kokoroProgress.loaded / kokoroProgress.total) * 100,
                      ),
                    ),
                  )}%`,
                }}
              />
            </span>
          ) : null}
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-surface px-4 py-3">
        <button
          type="button"
          onClick={() => {
            rum.event("media_action_fired", {
              action: "prev_page",
              source: "button",
            });
            goPrevPage();
          }}
          disabled={currentIdx === 0}
          aria-label="Previous page"
          title="Previous page (Shift+←)"
          className="rounded-md border border-border px-2 py-1.5 text-sm text-fg transition-colors hover:bg-surface-2 disabled:opacity-40"
        >
          ⟪
        </button>
        <button
          type="button"
          onClick={goPrev}
          disabled={currentIdx === 0}
          aria-label="Previous sentence"
          title="Previous sentence (←)"
          className="rounded-md border border-border px-3 py-1.5 text-sm text-fg transition-colors hover:bg-surface-2 disabled:opacity-40"
        >
          Prev
        </button>
        <button
          type="button"
          onClick={() => {
            rum.event("media_action_fired", {
              action: "restart_sentence",
              source: "button",
            });
            restartSentence();
          }}
          aria-label="Restart sentence"
          title="Restart sentence (R)"
          className="rounded-md border border-border px-2 py-1.5 text-sm text-fg transition-colors hover:bg-surface-2"
        >
          ↻
        </button>
        <button
          type="button"
          onClick={togglePlay}
          aria-label={
            !audioReady ? "Loading audio" : playing ? "Pause" : "Play"
          }
          className="inline-flex min-w-[5.5rem] items-center justify-center gap-1.5 rounded-md bg-accent px-4 py-1.5 text-sm font-medium text-accent-fg transition-colors hover:bg-accent-hover"
        >
          {!audioReady ? (
            <>
              <span
                aria-hidden
                className="h-3 w-3 animate-spin rounded-full border-2 border-accent-fg/40 border-t-accent-fg"
              />
              <span>Loading…</span>
            </>
          ) : playing ? (
            "Pause"
          ) : (
            "Play"
          )}
        </button>
        <button
          type="button"
          onClick={goNext}
          disabled={currentIdx >= sentenceCount - 1}
          aria-label="Next sentence"
          title="Next sentence (→)"
          className="rounded-md border border-border px-3 py-1.5 text-sm text-fg transition-colors hover:bg-surface-2 disabled:opacity-40"
        >
          Next
        </button>
        <button
          type="button"
          onClick={() => {
            rum.event("media_action_fired", {
              action: "next_page",
              source: "button",
            });
            goNextPage();
          }}
          disabled={currentIdx >= sentenceCount - 1}
          aria-label="Next page"
          title="Next page (Shift+→)"
          className="rounded-md border border-border px-2 py-1.5 text-sm text-fg transition-colors hover:bg-surface-2 disabled:opacity-40"
        >
          ⟫
        </button>

        <div className="ml-auto flex w-full flex-wrap items-center justify-end gap-x-3 gap-y-2 sm:w-auto">
          <label className="flex items-center gap-2 text-xs text-muted">
            <span>Voice</span>
            {/*
              Hybrid picker: a real <select> handles all behavior
              (native picker on mobile, keyboard nav, screen readers),
              but it's positioned absolutely with opacity:0 over our
              own styled div. The visible closed-state label is fully
              under our control, so the venus/mars symbols don't get
              clipped by iOS Safari's native text-line metrics.
            */}
            {(() => {
              const selectedVoice = voices.find((x) => x.id === voiceId);
              const symbol = selectedVoice
                ? voiceDisplaySymbol(selectedVoice)
                : "";
              const name = selectedVoice
                ? voiceDisplayName(selectedVoice)
                : voiceId;
              return (
                <div className="relative inline-flex">
                  <div className="pointer-events-none flex h-9 items-center gap-1 rounded-md border border-border bg-bg pl-3 pr-7 text-sm text-fg">
                    <span>{name}</span>
                    {symbol ? (
                      // The venus/mars glyphs sit ~8px below the
                      // optical center because of their cross/arrow
                      // descender. Lift the symbol's own span so it
                      // aligns with the name's visual center.
                      <span aria-hidden="true" className="-translate-y-[8px]">
                        {symbol}
                      </span>
                    ) : null}
                  </div>
                  <span
                    aria-hidden="true"
                    className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-[0.65rem] text-muted"
                  >
                    ▾
                  </span>
                  <select
                    value={voiceId}
                    onChange={(e) => onVoiceChange(e.target.value)}
                    aria-label="Voice"
                    className="absolute inset-0 h-full w-full cursor-pointer appearance-none border-0 bg-transparent text-sm opacity-0"
                  >
                    {voices.map((v) => (
                      <option key={v.id} value={v.id}>
                        {voiceDisplayLabel(v)}
                      </option>
                    ))}
                    {selectedVoice ? null : (
                      <option value={voiceId}>{voiceId}</option>
                    )}
                  </select>
                </div>
              );
            })()}
          </label>

          <label className="flex items-center gap-2 text-xs text-muted">
            <span>Speed</span>
            <select
              value={String(nearestSpeed(speed))}
              onChange={(e) => onSpeedChange(Number(e.target.value))}
              className="rounded-md border border-border bg-bg px-2 py-1 text-sm text-fg tabular-nums"
            >
              {SPEED_OPTIONS.map((opt) => (
                <option key={opt} value={opt}>
                  {opt.toFixed(2)}x
                </option>
              ))}
            </select>
          </label>

          <SleepTimerControl
            remainingMs={sleepRemainingMs}
            endOfPageActive={sleepMode.kind === "end-of-page"}
            defaultMinutes={sleepTimerDefaultMinutes}
            onStart={startSleepTimer}
            onStartEndOfPage={startEndOfPageTimer}
            onCancel={cancelSleepTimer}
            onExtend={extendSleepTimer}
          />

          <button
            type="button"
            onClick={() => {
              if (bookmarksOpen) setBookmarksOpen(false);
              else openBookmarks();
            }}
            aria-label="Bookmarks"
            aria-expanded={bookmarksOpen}
            title="Bookmarks (B to add)"
            className="rounded-md border border-border px-2 py-1 text-sm text-fg transition-colors hover:bg-surface-2"
          >
            ☰
          </button>

          {chapters.length > 0 ? (
            <button
              type="button"
              onClick={() => setChaptersOpen((v) => !v)}
              aria-label="Chapters"
              aria-expanded={chaptersOpen}
              title="Chapters"
              className="rounded-md border border-border px-2 py-1 text-sm text-fg transition-colors hover:bg-surface-2"
            >
              ❡
            </button>
          ) : null}

          <button
            type="button"
            onClick={() => setHardwareControlsOpen((v) => !v)}
            aria-label="Hardware controls"
            aria-expanded={hardwareControlsOpen}
            title="CarPlay & Bluetooth controls"
            className="rounded-md border border-border px-2 py-1 text-sm text-fg transition-colors hover:bg-surface-2"
          >
            ⚙
          </button>
        </div>
      </div>

      {hardwareControlsOpen ? (
        <HardwareControlsSettings
          settings={hardwareControls}
          onChange={onHardwareControlsChange}
          smartRewindSeconds={smartRewindSeconds}
          onSmartRewindChange={onSmartRewindChange}
          onClose={() => setHardwareControlsOpen(false)}
        />
      ) : null}

      {bookmarksOpen ? (
        <BookmarksPanel
          bookmarks={bookmarks}
          sentenceText={(idx) => sentencesByIdx.get(idx)?.text ?? null}
          onJump={(idx) => {
            seekTo(idx);
            setBookmarksOpen(false);
          }}
          onDelete={deleteBookmark}
          onEditNote={updateBookmarkNote}
          onClose={() => setBookmarksOpen(false)}
        />
      ) : null}

      {chaptersOpen ? (
        <ChaptersPanel
          chapters={chapters}
          currentSentenceIdx={currentIdx}
          onJump={(idx) => {
            advanceToIdx(idx, playingRef.current);
            setChaptersOpen(false);
          }}
          onClose={() => setChaptersOpen(false)}
        />
      ) : null}
    </div>
  );
}
