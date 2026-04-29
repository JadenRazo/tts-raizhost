// GET /api/tts?bookId=&idx= — TTS proxy with content-addressed Opus cache.
//
// Query-param based (rather than POST) so the response can be set as
// <audio src="/api/tts?..."> and the browser HTTP cache will reuse it.
// The Cache-Control: immutable below means re-playing a sentence is a
// zero-fetch local replay.
//
// Concurrency note: two simultaneous requests for the same uncached
// (book, idx) sentence will both hit Kokoro. The second writer's
// onConflictDoNothing handles the row race; the file rename is benign
// since the bytes are content-addressed (sha256 over voice|speed|text).

import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";

import { getSession } from "@/lib/auth/session";
import { getDb, schema } from "@/lib/db";
import {
  startTimer,
  ttsBackendRouteTotal,
  ttsCacheBytesTotal,
  ttsCacheHitsTotal,
  ttsCacheMissesTotal,
  ttsKokoroUpstreamDurationSeconds,
  ttsRequestDurationSeconds,
} from "@/lib/metrics";
import { isUuid } from "@/lib/storage";
import {
  type Backend,
  getActiveBackend,
  getActiveUrl,
  getFallbackUrl,
  recordRequestFailure,
  recordRequestSuccess,
} from "@/lib/tts-backend-selector";
import {
  audioFileSize,
  cacheKey,
  cacheLookup,
  cacheTouch,
  streamAudioFile,
  teeForCache,
  textHash,
} from "@/lib/tts-cache";
import {
  KokoroError,
  KokoroUnreachableError,
  synthesizeStream,
} from "@/lib/tts-client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DEFAULT_VOICE = "af_heart";
const DEFAULT_SPEED = 1.0;
const MAX_IDX = 200_000;
const MIN_SPEED = 0.5;
const MAX_SPEED = 2.0;

// Mirrors services/kokoro/synth.py:VOICE_CATALOG. Kept in sync manually —
// the set changes rarely, and rejecting forged voice IDs at the edge
// gives users a 400 instead of a 502 bouncing off the synth pod.
const ALLOWED_VOICES = new Set<string>([
  "af_heart",   // female, US, Kokoro v1.0 grade A (default)
  "af_bella",   // female, US, Kokoro v1.0 grade A-
  "am_michael", // male,   US, Kokoro v1.0 grade C+
  "am_puck",    // male,   US, Kokoro v1.0 grade C+
]);

function parseSpeedParam(raw: string | null): number | null {
  if (raw === null) return null;
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  if (n < MIN_SPEED || n > MAX_SPEED) return null;
  return Math.round(n * 100) / 100;
}

function audioHeaders(
  cacheStatus: "HIT" | "MISS",
  idx: number,
  byteLength: number | null,
  backendLabel: Backend | "cache",
): Record<string, string> {
  const h: Record<string, string> = {
    "Content-Type": "audio/ogg",
    "Cache-Control": "private, max-age=86400, immutable",
    "X-Cache": cacheStatus,
    "X-Sentence-Idx": String(idx),
    // Visibility into which backend served the bytes. For HIT the
    // original synth backend isn't stored per cache row, so we tag
    // 'cache' rather than guess.
    "Last-TTS-Backend": backendLabel,
  };
  if (byteLength !== null) {
    h["Content-Length"] = String(byteLength);
  }
  return h;
}

// Observe tts_request_duration_seconds when the response body has been
// fully sent (or the connection closed). For non-streaming responses
// (early errors) we observe immediately at the end of the handler.
function observeOnStreamEnd(
  body: ReadableStream<Uint8Array>,
  labels: { cache: "hit" | "miss"; voice: string; status: string },
  elapsedSeconds: () => number,
  bytesLabel: "hit" | "miss",
): ReadableStream<Uint8Array> {
  let bytes = 0;
  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        bytes += chunk.byteLength;
        controller.enqueue(chunk);
      },
      flush() {
        ttsRequestDurationSeconds.labels(labels).observe(elapsedSeconds());
        ttsCacheBytesTotal.labels({ cache_status: bytesLabel }).inc(bytes);
      },
    }),
  );
}

export async function GET(req: Request) {
  const elapsed = startTimer();

  const session = await getSession();
  if (!session) {
    ttsRequestDurationSeconds
      .labels({ cache: "miss", voice: "unknown", status: "401" })
      .observe(elapsed());
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const userId = session.user.id;

  const url = new URL(req.url);
  const bookId = url.searchParams.get("bookId") ?? "";
  const idxRaw = url.searchParams.get("idx") ?? "";
  const voiceParam = url.searchParams.get("voice");
  const speedParam = url.searchParams.get("speed");

  if (!isUuid(bookId)) {
    ttsRequestDurationSeconds
      .labels({ cache: "miss", voice: "unknown", status: "404" })
      .observe(elapsed());
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const idx = Number(idxRaw);
  if (
    !Number.isInteger(idx) ||
    idx < 0 ||
    idx > MAX_IDX ||
    String(idx) !== idxRaw.trim()
  ) {
    ttsRequestDurationSeconds
      .labels({ cache: "miss", voice: "unknown", status: "400" })
      .observe(elapsed());
    return NextResponse.json({ error: "Invalid idx" }, { status: 400 });
  }

  if (voiceParam !== null && !ALLOWED_VOICES.has(voiceParam)) {
    ttsRequestDurationSeconds
      .labels({ cache: "miss", voice: "unknown", status: "400" })
      .observe(elapsed());
    return NextResponse.json({ error: "Unknown voice" }, { status: 400 });
  }
  const parsedSpeed = parseSpeedParam(speedParam);
  if (speedParam !== null && parsedSpeed === null) {
    ttsRequestDurationSeconds
      .labels({ cache: "miss", voice: voiceParam ?? "unknown", status: "400" })
      .observe(elapsed());
    return NextResponse.json({ error: "Invalid speed" }, { status: 400 });
  }

  const db = getDb();

  const owned = await db
    .select({ id: schema.books.id })
    .from(schema.books)
    .where(and(eq(schema.books.id, bookId), eq(schema.books.userId, userId)))
    .limit(1);
  if (owned.length === 0) {
    ttsRequestDurationSeconds
      .labels({ cache: "miss", voice: voiceParam ?? "unknown", status: "404" })
      .observe(elapsed());
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  let voiceId: string;
  let speed: number;
  let settingsSource: "url" | "settings";
  if (voiceParam !== null && parsedSpeed !== null) {
    voiceId = voiceParam;
    speed = parsedSpeed;
    settingsSource = "url";
  } else {
    settingsSource = "settings";
    voiceId = DEFAULT_VOICE;
    speed = DEFAULT_SPEED;
    const settingsRows = await db
      .select({
        voiceId: schema.userSettings.voiceId,
        speed: schema.userSettings.speed,
      })
      .from(schema.userSettings)
      .where(eq(schema.userSettings.userId, userId))
      .limit(1);
    if (settingsRows.length > 0) {
      const savedVoice = settingsRows[0].voiceId;
      voiceId = ALLOWED_VOICES.has(savedVoice) ? savedVoice : DEFAULT_VOICE;
      speed = Number(settingsRows[0].speed);
    } else {
      await db
        .insert(schema.userSettings)
        .values({ userId })
        .onConflictDoNothing();
    }
    if (voiceParam !== null) voiceId = voiceParam;
    if (parsedSpeed !== null) speed = parsedSpeed;
  }
  console.info("[tts] request", {
    userId,
    bookId,
    idx,
    voice: voiceId,
    speed,
    source: settingsSource,
  });

  const sentenceRows = await db
    .select({ text: schema.bookSentences.text })
    .from(schema.bookSentences)
    .where(
      and(
        eq(schema.bookSentences.bookId, bookId),
        eq(schema.bookSentences.idx, idx),
      ),
    )
    .limit(1);
  if (sentenceRows.length === 0) {
    ttsRequestDurationSeconds
      .labels({ cache: "miss", voice: voiceId, status: "404" })
      .observe(elapsed());
    return NextResponse.json({ error: "Sentence not found" }, { status: 404 });
  }
  const sentenceText = sentenceRows[0].text;

  const key = cacheKey(voiceId, speed, sentenceText);

  const hit = await cacheLookup(db, key);
  if (hit) {
    const onDisk = await audioFileSize(hit.audioPath);
    if (onDisk !== null) {
      ttsCacheHitsTotal.labels({ voice: voiceId }).inc();
      void cacheTouch(db, key).catch((err) =>
        console.error("[tts] cacheTouch failed", err),
      );
      const observed = observeOnStreamEnd(
        streamAudioFile(hit.audioPath),
        { cache: "hit", voice: voiceId, status: "200" },
        elapsed,
        "hit",
      );
      ttsBackendRouteTotal.labels({ backend: "cache", outcome: "ok" }).inc();
      return new Response(observed, {
        status: 200,
        headers: audioHeaders("HIT", idx, onDisk, "cache"),
      });
    }
    console.warn("[tts] cache row points at missing file", {
      cacheKey: key,
      audioPath: hit.audioPath,
    });
  }

  // Cache miss: synthesize via the active backend. The selector picks
  // gpu (home box over Tailscale) or cpu (in-cluster pod); on a
  // primary-side KokoroUnreachableError we retry once against the
  // fallback URL inside this same request. The probe loop owns the
  // longer-term breaker state — see lib/tts-backend-selector.ts.
  ttsCacheMissesTotal.labels({ voice: voiceId }).inc();
  const upstreamStart = startTimer();
  let upstream: ReadableStream<Uint8Array>;
  let backendUsed: Backend = getActiveBackend();
  try {
    upstream = await synthesizeStream(sentenceText, voiceId, speed, req.signal, {
      baseUrl: getActiveUrl(),
    });
    recordRequestSuccess();
    ttsKokoroUpstreamDurationSeconds
      .labels({ voice: voiceId, outcome: "ok" })
      .observe(upstreamStart());
    ttsBackendRouteTotal.labels({ backend: backendUsed, outcome: "ok" }).inc();
  } catch (err) {
    // Primary-side network failure: bump the breaker counter and try
    // the fallback once before surfacing 503 to the client. If primary
    // was already cpu (selector flipped earlier), don't retry — there's
    // nothing else to fall back to.
    const wasGpu = backendUsed === "gpu";
    if (err instanceof KokoroUnreachableError && wasGpu) {
      recordRequestFailure();
      ttsBackendRouteTotal.labels({ backend: "gpu", outcome: "fallback" }).inc();
      console.warn("[tts] gpu unreachable, falling back to cpu", err.message);
      try {
        upstream = await synthesizeStream(sentenceText, voiceId, speed, req.signal, {
          baseUrl: getFallbackUrl(),
        });
        backendUsed = "cpu";
        ttsKokoroUpstreamDurationSeconds
          .labels({ voice: voiceId, outcome: "ok" })
          .observe(upstreamStart());
        ttsBackendRouteTotal.labels({ backend: "cpu", outcome: "ok" }).inc();
      } catch (fallbackErr) {
        ttsBackendRouteTotal.labels({ backend: "cpu", outcome: "fail" }).inc();
        return synthErrorToResponse(fallbackErr, voiceId, upstreamStart, elapsed);
      }
    } else {
      if (err instanceof KokoroUnreachableError) recordRequestFailure();
      ttsBackendRouteTotal.labels({ backend: backendUsed, outcome: "fail" }).inc();
      return synthErrorToResponse(err, voiceId, upstreamStart, elapsed);
    }
  }

  const forClient = teeForCache(db, {
    cacheKey: key,
    voiceId,
    textHash: textHash(sentenceText),
    durationMs: 0,
    source: upstream,
  });

  const observed = observeOnStreamEnd(
    forClient,
    { cache: "miss", voice: voiceId, status: "200" },
    elapsed,
    "miss",
  );

  return new Response(observed, {
    status: 200,
    headers: audioHeaders("MISS", idx, null, backendUsed),
  });
}

/** Map a synth-side exception to a Next response. Used by the cache-miss
 * path's primary-and-fallback try-blocks. Records the upstream-duration
 * histogram and the request-duration histogram with the right status. */
function synthErrorToResponse(
  err: unknown,
  voiceId: string,
  upstreamStart: () => number,
  elapsed: () => number,
): Response {
  if (err instanceof KokoroUnreachableError) {
    ttsKokoroUpstreamDurationSeconds
      .labels({ voice: voiceId, outcome: "timeout" })
      .observe(upstreamStart());
    ttsRequestDurationSeconds
      .labels({ cache: "miss", voice: voiceId, status: "503" })
      .observe(elapsed());
    console.error("[tts] kokoro unreachable", err.message);
    return NextResponse.json(
      { error: "Voice service unavailable" },
      { status: 503, headers: { "Retry-After": "5" } },
    );
  }
  if (err instanceof KokoroError) {
    const outcome = err.status === 503 ? "503" : err.status === 502 ? "502" : "ok";
    ttsKokoroUpstreamDurationSeconds
      .labels({ voice: voiceId, outcome })
      .observe(upstreamStart());
    ttsRequestDurationSeconds
      .labels({ cache: "miss", voice: voiceId, status: String(err.status === 503 ? 503 : 502) })
      .observe(elapsed());
    console.error("[tts] kokoro error", err.status, err.message);
    if (err.status === 503) {
      return NextResponse.json(
        { error: "Voice service unavailable" },
        { status: 503, headers: { "Retry-After": "5" } },
      );
    }
    return NextResponse.json(
      { error: "Voice service error" },
      { status: 502 },
    );
  }
  ttsKokoroUpstreamDurationSeconds
    .labels({ voice: voiceId, outcome: "timeout" })
    .observe(upstreamStart());
  ttsRequestDurationSeconds
    .labels({ cache: "miss", voice: voiceId, status: "500" })
    .observe(elapsed());
  console.error("[tts] synthesize failed", err);
  return NextResponse.json({ error: "Synthesis failed" }, { status: 500 });
}
