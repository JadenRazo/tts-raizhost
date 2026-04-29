// Background pre-render of an entire book at a given (voice, speed).
//
// We iterate every sentence, hash to a cache key, skip if it's already
// on disk, otherwise stream from kokoro and persist to the audio cache
// + tts_cache row. After the prerender completes, every subsequent
// /api/tts request for that (book, voice, speed) is a hot cache hit
// and the user never waits for synthesis again — the only real-time
// path is voice/speed changes against an un-prerendered combination.
//
// Throttled lightly (small inter-sentence delay) so an active user
// reading the book at the same time isn't completely starved of
// kokoro CPU. Idempotent — re-running is a no-op for already-cached
// sentences.

import { Buffer } from "node:buffer";
import { and, asc, eq } from "drizzle-orm";

import {
  audioFileSize,
  cacheKey,
  cacheLookup,
  cacheStore,
  textHash,
} from "@/lib/tts-cache";
import type { Database } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { prerenderInflight, prerenderJobsTotal } from "@/lib/metrics";
import { synthesizeStream } from "@/lib/tts-client";

// Pause this long between sentences so an active reading session can
// interleave a real synth request without queueing for ages behind the
// prerender. With Piper medium synthesizing a typical sentence in
// ~400-700 ms, a 400 ms pause renders ~70 sentences/min and a 4500-
// sentence book completes in ~65 min. Active readers still get fair
// access via the synth-slot semaphore (PIPER_MAX_CONCURRENT_SYNTH=2);
// this pause is just a courtesy throttle on top of that.
const INTER_SENTENCE_PAUSE_MS = 400;

// Drain a ReadableStream into a single Buffer.
async function drainStream(
  stream: ReadableStream<Uint8Array>,
): Promise<Buffer> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value);
      total += value.byteLength;
    }
  }
  return Buffer.concat(
    chunks.map((c) => Buffer.from(c)),
    total,
  );
}

export type PrerenderStats = {
  bookId: string;
  voiceId: string;
  speed: number;
  total: number;
  rendered: number;
  skipped: number;
  failed: number;
  durationMs: number;
};

// In-process registry so a second prerender request for the same
// (book, voice, speed) just reattaches to the running one instead of
// starting a duplicate. Cleared when the run finishes (success or fail).
const inflight = new Map<string, Promise<PrerenderStats>>();

function jobKey(bookId: string, voiceId: string, speed: number): string {
  return `${bookId}|${voiceId}|${speed.toFixed(2)}`;
}

export function isPrerenderInflight(
  bookId: string,
  voiceId: string,
  speed: number,
): boolean {
  return inflight.has(jobKey(bookId, voiceId, speed));
}

export async function prerenderBook(
  db: Database,
  bookId: string,
  voiceId: string,
  speed: number,
  signal?: AbortSignal,
): Promise<PrerenderStats> {
  const key = jobKey(bookId, voiceId, speed);
  const existing = inflight.get(key);
  if (existing) return existing;

  prerenderInflight.inc();
  const promise = (async () => {
    const started = Date.now();
    const stats: PrerenderStats = {
      bookId,
      voiceId,
      speed,
      total: 0,
      rendered: 0,
      skipped: 0,
      failed: 0,
      durationMs: 0,
    };

    const sentences = await db
      .select({
        idx: schema.bookSentences.idx,
        text: schema.bookSentences.text,
      })
      .from(schema.bookSentences)
      .where(eq(schema.bookSentences.bookId, bookId))
      .orderBy(asc(schema.bookSentences.idx));

    stats.total = sentences.length;

    for (const sentence of sentences) {
      if (signal?.aborted) break;

      const sha = cacheKey(voiceId, speed, sentence.text);
      const hit = await cacheLookup(db, sha);
      if (hit) {
        const onDisk = await audioFileSize(hit.audioPath);
        if (onDisk !== null) {
          stats.skipped++;
          continue;
        }
      }

      try {
        const stream = await synthesizeStream(
          sentence.text,
          voiceId,
          speed,
          signal,
        );
        const audio = await drainStream(stream);
        if (audio.byteLength === 0) {
          stats.failed++;
          continue;
        }
        await cacheStore(db, {
          cacheKey: sha,
          voiceId,
          textHash: textHash(sentence.text),
          audio,
          durationMs: 0,
        });
        stats.rendered++;
      } catch (err) {
        if (signal?.aborted) break;
        stats.failed++;
        console.warn("[prerender] synth failed", {
          bookId,
          idx: sentence.idx,
          err: err instanceof Error ? err.message : String(err),
        });
      }

      // Yield to active synth requests. Sleep is interruptible via the
      // AbortSignal so a Cancel from the caller doesn't have to wait
      // out the pause.
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, INTER_SENTENCE_PAUSE_MS);
        const onAbort = () => {
          clearTimeout(timer);
          resolve();
        };
        signal?.addEventListener("abort", onAbort, { once: true });
      });
    }

    stats.durationMs = Date.now() - started;
    return stats;
  })();

  inflight.set(key, promise);
  promise
    .then((stats) => {
      const outcome = stats.failed === 0 ? "ok" : stats.rendered > 0 ? "partial" : "failed";
      prerenderJobsTotal.labels({ outcome }).inc();
    })
    .catch(() => {
      prerenderJobsTotal.labels({ outcome: "error" }).inc();
    })
    .finally(() => {
      prerenderInflight.dec();
      inflight.delete(key);
    });
  return promise;
}
