"use client";

// Client-side audio resolver for the reader. Given a (book, idx,
// voice, speed) triple, pick the cheapest source: existing server
// cache, browser-side kokoro inference, or fresh server synthesis.
//
// Decision tree (per call):
//
//   1. Backend = "server" or unset       → fetch server URL directly.
//   2. Backend = "webgpu" / "wasm"       → probe `?probe=1`:
//      • 204 (server cache hit)          → use server URL (the audio
//                                          element will refetch and the
//                                          browser HTTP cache will serve
//                                          the bytes that prefetch
//                                          warmed).
//      • 404 (server cache miss)         → run client synth; on success
//                                          return a blob: URL.
//      • Anything else                   → fall back to direct server
//                                          fetch — never surface a probe
//                                          failure to the user.
//   3. Browser-synth failure of any kind → fall back to direct server
//      fetch as if backend was "server".
//
// We don't write the blob to the server cache. Roundtripping a 200 KB
// WAV upload after every local synth is more bandwidth than just
// regenerating on next miss — and the prefetch path (currentIdx + 1,
// + 2) keeps the server cache warm separately.

import { getCachedBackend } from "@/lib/gpu-capability";
import { getClient } from "@/lib/kokoro-webgpu-client";

export type AudioSource = "server-cache" | "server-synth" | "browser";

export type AudioRef = {
  url: string;
  durationHintMs?: number;
  source: AudioSource;
};

export type FetchAudioOpts = {
  bookId: string;
  idx: number;
  text: string;
  voice: string;
  speed: number;
  signal?: AbortSignal;
};

function buildServerUrl(opts: {
  bookId: string;
  idx: number;
  voice: string;
  speed: number;
}): string {
  return (
    `/api/tts?bookId=${encodeURIComponent(opts.bookId)}` +
    `&idx=${opts.idx}` +
    `&voice=${encodeURIComponent(opts.voice)}` +
    `&speed=${opts.speed.toFixed(2)}`
  );
}

async function probeServerCache(
  serverUrl: string,
  signal?: AbortSignal,
): Promise<"hit" | "miss" | "unknown"> {
  try {
    const res = await fetch(`${serverUrl}&probe=1`, { method: "GET", signal });
    if (res.status === 204) return "hit";
    if (res.status === 404) return "miss";
    return "unknown";
  } catch {
    // Aborts and network errors both fall through to "unknown" so the
    // caller can degrade to the direct server fetch (which will likely
    // hit the browser HTTP cache anyway).
    return "unknown";
  }
}

export async function fetchAudio(opts: FetchAudioOpts): Promise<AudioRef> {
  const serverUrl = buildServerUrl(opts);
  const backend = getCachedBackend();

  if (backend !== "webgpu" && backend !== "wasm") {
    return { url: serverUrl, source: "server-synth" };
  }

  const probeResult = await probeServerCache(serverUrl, opts.signal);
  if (opts.signal?.aborted) {
    throw new DOMException("aborted", "AbortError");
  }

  if (probeResult === "hit") {
    return { url: serverUrl, source: "server-cache" };
  }

  if (probeResult === "unknown") {
    // Probe didn't tell us anything useful — let the audio element
    // fetch the server URL the regular way. Don't burn local GPU on a
    // race we can't reason about.
    return { url: serverUrl, source: "server-synth" };
  }

  // Probe = "miss" — synthesize locally.
  try {
    const client = getClient(backend);
    const blob = await client.synth(opts.text, opts.voice, opts.speed);
    if (opts.signal?.aborted) {
      throw new DOMException("aborted", "AbortError");
    }
    const sampleRate = 24000;
    const headerBytes = 44;
    const sampleCount = Math.max(0, (blob.size - headerBytes) / 2);
    const durationHintMs = (sampleCount / sampleRate) * 1000;
    return {
      url: URL.createObjectURL(blob),
      source: "browser",
      durationHintMs,
    };
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") throw err;
    console.warn("[tts-routing] browser synth failed; falling back to server", err);
    return { url: serverUrl, source: "server-synth" };
  }
}
