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

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { rum } from "@/lib/rum";
import type { Voice } from "@/lib/tts-client";

export type ReaderSentence = {
  idx: number;
  page: number;
  text: string;
};

type Position = { sentenceIdx: number; charOffset: number };

type Props = {
  bookId: string;
  sentenceCount: number;
  initialSentences: ReaderSentence[];
  initialPosition: Position;
  initialVoiceId: string;
  initialSpeed: number;
  voices: Voice[];
};

type AlertState =
  | { kind: "service-warming"; retryAt: number }
  | { kind: "synth-failed"; idx: number; advanceAt: number }
  | { kind: "end-of-book" }
  | null;

const SPEED_OPTIONS = [0.75, 1.0, 1.25, 1.5, 2.0];
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
  return Math.min(2.0, Math.max(0.5, value));
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

export function Reader({
  bookId,
  sentenceCount,
  initialSentences,
  initialPosition,
  initialVoiceId,
  initialSpeed,
  voices,
}: Props) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
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
  // Per-idx retry counter so a single dropped chunk doesn't immediately
  // strand playback. Cleared on idx change.
  const retryCountRef = useRef<Map<number, number>>(new Map());

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

  const currentSentence = sentencesByIdx.get(currentIdx) ?? null;

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
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    if (!Number.isFinite(currentIdx) || currentIdx < 0) return;
    audio.src = ttsUrl(bookId, currentIdx, voiceId, speed);
    audio.load();
    setAudioReady(false);
    // New idx → reset its retry counter (a fresh attempt for a brand-new
    // sentence shouldn't inherit a previous one's strikes).
    retryCountRef.current.delete(currentIdx);
  }, [bookId, currentIdx, voiceId, speed]);

  // Scroll the active sentence into view smoothly.
  useEffect(() => {
    const el = itemRefs.current.get(currentIdx);
    if (!el) return;
    el.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [currentIdx]);

  // Warm the cache for the *next* sentence (currentIdx + 1) so the
  // auto-advance is a cache hit. Three rules:
  //   1. Only when `audioReady` is true — the active synth has finished
  //      its initial buffer and kokoro is idle.
  //   2. Debounced — if the user is rapid-clicking Next/Prev, every
  //      click would otherwise queue a fresh kokoro job and saturate
  //      the pod. With PREFETCH_DEBOUNCE_MS the user has to "settle"
  //      on a sentence before we warm the one after it.
  //   3. Aborted on cleanup — if currentIdx changes again, abort any
  //      in-flight prefetch so kokoro doesn't keep working on the
  //      now-stale guess. The route propagates the client AbortSignal
  //      through to its own kokoro fetch.
  useEffect(() => {
    if (sentenceCount <= 0) return;
    if (!audioReady) return;
    const next = currentIdx + 1;
    if (next < 0 || next >= sentenceCount) return;
    const controller = new AbortController();
    const t = setTimeout(() => {
      rum.event("prefetch_fired", { outcome: "fired" });
      void fetch(ttsUrl(bookId, next, voiceId, speed), {
        cache: "force-cache",
        signal: controller.signal,
      }).catch(() => {});
    }, PREFETCH_DEBOUNCE_MS);
    return () => {
      clearTimeout(t);
      controller.abort();
    };
  }, [bookId, voiceId, speed, currentIdx, sentenceCount, audioReady]);

  const handleEnded = useCallback(() => {
    rum.event("audio_ended");
    setCurrentIdx((idx) => {
      const next = idx + 1;
      if (next >= sentenceCount) {
        setPlaying(false);
        setAlert({ kind: "end-of-book" });
        return idx;
      }
      return next;
    });
  }, [sentenceCount]);

  // canplay: the audio element has enough buffered to start playing.
  // If the user wants playback (intent), kick it off now. Survives
  // every src change (voice/speed/idx) so playback resumes
  // automatically without the user re-tapping Play.
  const handleCanPlay = useCallback(() => {
    setAudioReady(true);
    rum.event("audio_can_play");
    rum.timing.start("can_play_to_audible");
    const audio = audioRef.current;
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
  }, []);

  const handleAudioWaiting = useCallback(() => {
    setAudioReady(false);
  }, []);

  const handleAudioLoadStart = useCallback(() => {
    setAudioReady(false);
  }, []);

  const handleAudioError = useCallback(() => {
    const audio = audioRef.current;
    if (!audio) return;
    // The browser fires `error` for any non-2xx fetch as well as decode
    // failures. Probe the URL once to learn the real cause.
    void fetch(ttsUrl(bookId, currentIdx, voiceId, speed), { method: "GET" })
      .then(async (res) => {
        if (res.status === 503) {
          rum.event("audio_error", { kind: "service-warming" });
          // Service warming — keep intent, schedule a retry of the same idx.
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
      const audio = audioRef.current;
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
  // the alert UI to abort this and keep the alert visible.
  useEffect(() => {
    if (alert?.kind !== "synth-failed") return;
    const delay = Math.max(0, alert.advanceAt - Date.now());
    const t = setTimeout(() => {
      setAlert(null);
      setCurrentIdx((idx) => {
        const next = idx + 1;
        if (next >= sentenceCount) {
          setPlaying(false);
          setAlert({ kind: "end-of-book" });
          return idx;
        }
        return next;
      });
    }, delay);
    return () => clearTimeout(t);
  }, [alert, sentenceCount]);

  // 503 retry: after SERVICE_RETRY_MS, reload the same idx. Intent
  // (`playing`) is preserved across the alert window, so canplay will
  // restart playback automatically. We only clear the alert here; the
  // canplay handler does the play() call.
  useEffect(() => {
    if (alert?.kind !== "service-warming") return;
    const delay = Math.max(0, alert.retryAt - Date.now());
    const t = setTimeout(() => {
      const audio = audioRef.current;
      if (!audio) return;
      audio.src = ttsUrl(bookId, currentIdx, voiceId, speed);
      audio.load();
      setAudioReady(false);
      setAlert(null);
    }, delay);
    return () => clearTimeout(t);
  }, [alert, bookId, currentIdx, voiceId, speed]);

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

  // Save on pause/blur/beforeunload.
  useEffect(() => {
    function onUnload() {
      savePositionNow(currentIdx, true);
    }
    function onPagehide() {
      savePositionNow(currentIdx, true);
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
    const audio = audioRef.current;
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
    if (!audio.src) {
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
  }, [bookId, currentIdx, voiceId, speed]);

  const goPrev = useCallback(() => {
    setAlert(null);
    setCurrentIdx((idx) => Math.max(0, idx - 1));
  }, []);

  const goNext = useCallback(() => {
    setAlert(null);
    setCurrentIdx((idx) => {
      const next = idx + 1;
      if (next >= sentenceCount) return idx;
      return next;
    });
  }, [sentenceCount]);

  const seekTo = useCallback(
    (idx: number) => {
      if (idx < 0 || idx >= sentenceCount) return;
      setAlert(null);
      setCurrentIdx(idx);
      // If user clicks while paused, leave paused; if playing, the src
      // change effect will autoplay.
    },
    [sentenceCount],
  );

  // Trigger a background prerender of the entire book in the current
  // (voice, speed). Fires on mount, on voice change, and on speed
  // change. The server dedupes concurrent calls for the same triple
  // so this is safe to call freely. Once the prerender completes,
  // every sentence in this voice/speed is a hot cache hit and the
  // user never waits for kokoro again — only voice/speed changes
  // against an un-prerendered combination pay real-time synth cost.
  const triggerPrerender = useCallback(
    (voice: string, speedValue: number) => {
      rum.event("prerender_triggered", { voice, speed: speedValue });
      void fetch(`/api/books/${encodeURIComponent(bookId)}/prerender`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ voice, speed: speedValue }),
        keepalive: true,
      }).catch(() => {});
    },
    [bookId],
  );

  useEffect(() => {
    triggerPrerender(voiceId, speed);
  }, [triggerPrerender, voiceId, speed]);

  // Web Vitals — lazy-imported so the ~3KB module isn't part of the
  // landing/library SSR bundle. Only loaded on the reader page where
  // the metrics are most actionable (LCP for the first sentence list,
  // INP for tap responsiveness, CLS for the active-sentence scroll).
  useEffect(() => {
    let cancelled = false;
    void import("web-vitals").then((mod) => {
      if (cancelled) return;
      mod.onLCP(rum.vital);
      mod.onINP(rum.vital);
      mod.onCLS(rum.vital);
      mod.onFCP(rum.vital);
      mod.onTTFB(rum.vital);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Push voice/speed changes to the server. Best-effort — UI updates
  // optimistically.
  const persistSettings = useCallback(
    async (patch: { voiceId?: string; speed?: number }) => {
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
        goPrev();
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        goNext();
      } else if (e.key === "[") {
        e.preventDefault();
        onSpeedChange(stepSpeed(speed, -1));
      } else if (e.key === "]") {
        e.preventDefault();
        onSpeedChange(stepSpeed(speed, 1));
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [togglePlay, goPrev, goNext, onSpeedChange, speed]);

  // ---------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------

  return (
    <div className="flex flex-col gap-6">
      <audio
        ref={audioRef}
        onEnded={handleEnded}
        onError={handleAudioError}
        onCanPlay={handleCanPlay}
        onPlaying={handleAudioPlaying}
        onWaiting={handleAudioWaiting}
        onLoadStart={handleAudioLoadStart}
        onStalled={handleAudioStalled}
        onProgress={handleAudioProgress}
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
                {s.text}
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

      <div className="flex flex-wrap items-center gap-3 rounded-lg border border-border bg-surface px-4 py-3">
        <button
          type="button"
          onClick={goPrev}
          disabled={currentIdx === 0}
          aria-label="Previous sentence"
          className="rounded-md border border-border px-3 py-1.5 text-sm text-fg transition-colors hover:bg-surface-2 disabled:opacity-40"
        >
          Prev
        </button>
        <button
          type="button"
          onClick={togglePlay}
          aria-label={
            playing ? (audioReady ? "Pause" : "Loading audio") : "Play"
          }
          className="inline-flex min-w-[5.5rem] items-center justify-center gap-1.5 rounded-md bg-accent px-4 py-1.5 text-sm font-medium text-accent-fg transition-colors hover:bg-accent-hover"
        >
          {playing && !audioReady ? (
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
          className="rounded-md border border-border px-3 py-1.5 text-sm text-fg transition-colors hover:bg-surface-2 disabled:opacity-40"
        >
          Next
        </button>

        <div className="ml-auto flex items-center gap-3">
          <label className="flex items-center gap-2 text-xs text-muted">
            <span>Voice</span>
            <select
              value={voiceId}
              onChange={(e) => onVoiceChange(e.target.value)}
              className="rounded-md border border-border bg-bg px-2 py-1 text-sm text-fg"
            >
              {voices.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.id}
                </option>
              ))}
              {voices.find((v) => v.id === voiceId) ? null : (
                <option value={voiceId}>{voiceId}</option>
              )}
            </select>
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
        </div>
      </div>

      <div className="flex items-center justify-between text-xs text-subtle">
        <span>
          Sentence {currentIdx + 1} of {sentenceCount}
          {currentSentence ? ` · page ${currentSentence.page}` : ""}
        </span>
        <span className="hidden sm:inline">
          Space play/pause · ← → step · [ ] speed
        </span>
      </div>
    </div>
  );
}
