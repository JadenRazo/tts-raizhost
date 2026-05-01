// Content-addressed audio cache.
//
// Layout: <CACHE_DIR>/<voiceId>/<cacheKey>.opus
// Key:    sha256("v1|" + voiceId + "|" + speed.toFixed(2) + "|" + text)
//
// The "v1" version literal is deliberate — bumping it invalidates the entire
// cache cleanly when we change the synthesis pipeline (e.g. ffmpeg flags,
// post-processing) without needing a destructive migration.
//
// Path-traversal hardening: voiceId must match the Piper id pattern
// (^[a-z]{2}_[A-Z]{2}-[a-z][a-z0-9_]*-[a-z]+$). Anything else throws
// before touching the filesystem.

import { spawn } from "node:child_process";
import crypto from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, open, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { eq, sql } from "drizzle-orm";

import type { Database } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { env } from "@/lib/env";

// Kokoro voice ID format: `<lang_code><gender>_<name>`, e.g. af_heart,
// am_michael, bf_emma. Two lowercase letters, underscore, then a name
// of lowercase letters and digits. The route's ALLOWED_VOICES set is
// the authoritative whitelist; this regex is a syntactic sanity check
// for the cache key path.
const VOICE_ID_RE = /^[a-z]{2}_[a-z][a-z0-9_]*$/;
const CACHE_KEY_RE = /^[0-9a-f]{64}$/;
const CACHE_VERSION = "v1";

export function isVoiceId(value: string): boolean {
  return VOICE_ID_RE.test(value);
}

function assertVoiceId(value: string): void {
  if (!isVoiceId(value)) {
    throw new Error("Invalid voiceId");
  }
}

function assertCacheKey(value: string): void {
  if (!CACHE_KEY_RE.test(value)) {
    throw new Error("Invalid cacheKey");
  }
}

export function cacheKey(
  voiceId: string,
  speed: number,
  text: string,
): string {
  assertVoiceId(voiceId);
  const composite = `${CACHE_VERSION}|${voiceId}|${speed.toFixed(2)}|${text}`;
  return crypto.createHash("sha256").update(composite, "utf8").digest("hex");
}

export function textHash(text: string): string {
  return crypto.createHash("sha256").update(text, "utf8").digest("hex");
}

export function cachePath(voiceId: string, key: string): string {
  assertVoiceId(voiceId);
  assertCacheKey(key);
  return path.join(env.CACHE_DIR, voiceId, `${key}.opus`);
}

// Silence-trim post-process. Pipes the cached Opus file through
// ffmpeg's silenceremove filter to strip leading/trailing silence
// that kokoro emits (~50-200ms each). The trim is best-effort and
// idempotent — re-running on already-trimmed audio is mostly a
// no-op since there's no silence to remove.
//
// Why -40dB threshold: kokoro's silent regions sit around -60 to
// -50dB; speech rises to -10dB at peak. -40dB cuts the silence
// without clipping the leading consonants of a word starting at
// low volume.
//
// Why 0.04s minimum silence: any shorter and we risk trimming the
// natural micro-pause before a stressed word (which would make the
// utterance sound rushed). 40ms is below conscious perception of
// silence as a "pause" but long enough that real silence is reliably
// detected.
//
// The filter chain:
//   1. silenceremove(start_periods=1, ...): removes leading silence.
//   2. areverse: flip the stream so trailing-silence becomes leading.
//   3. silenceremove(start_periods=1, ...): removes that "new
//      leading" silence (i.e. the original trailing silence).
//   4. areverse: restore original direction.
const SILENCE_TRIM_AFILTER =
  "silenceremove=start_periods=1:start_silence=0.04:start_threshold=-40dB:detection=peak," +
  "areverse," +
  "silenceremove=start_periods=1:start_silence=0.04:start_threshold=-40dB:detection=peak," +
  "areverse";

// One-shot disable flag set on first ffmpeg failure so we don't spam
// logs on every cache write. Reset by process restart. Distinct from
// env.TTS_SILENCE_TRIM (which is the operator's intent).
let ffmpegRuntimeAvailable = true;

/** Trim leading/trailing silence from an Opus file in place. Atomic
 *  via tmp+rename. Returns the new file size in bytes (or null on
 *  failure / disabled). Failures are logged and the file is left
 *  untouched, so the upstream cache path keeps working even when
 *  ffmpeg is missing or rejects the input. */
async function trimSilenceInPlace(
  audioPath: string,
): Promise<number | null> {
  if (!env.TTS_SILENCE_TRIM) return null;
  if (!env.FFMPEG_BIN) return null;
  if (!ffmpegRuntimeAvailable) return null;

  const rand = crypto.randomBytes(3).toString("hex");
  const tmpPath = `${audioPath}.trim.${process.pid}.${rand}.tmp`;

  const code = await new Promise<number>((resolve) => {
    const ff = spawn(
      env.FFMPEG_BIN,
      [
        "-y",
        "-loglevel",
        "error",
        "-i",
        audioPath,
        "-af",
        SILENCE_TRIM_AFILTER,
        "-c:a",
        "libopus",
        // Match the upstream synth bitrate so the cached size doesn't
        // grow on transcode.
        "-b:a",
        "32k",
        "-vbr",
        "on",
        "-application",
        "voip",
        tmpPath,
      ],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    let stderr = "";
    ff.stderr?.on("data", (d) => {
      stderr += String(d);
    });
    ff.on("error", (err) => {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        // ffmpeg binary missing — disable for the rest of this
        // process's lifetime so we don't retry on every cache write.
        ffmpegRuntimeAvailable = false;
        console.warn(
          `[tts] silence-trim disabled: ffmpeg not found at "${env.FFMPEG_BIN}". ` +
            "Set TTS_SILENCE_TRIM=0 to silence this warning, or install ffmpeg.",
        );
      } else {
        console.warn("[tts] silence-trim ffmpeg spawn failed", err.message);
      }
      resolve(-1);
    });
    ff.on("close", (rc) => {
      if (rc !== 0) {
        console.warn(
          `[tts] silence-trim ffmpeg exit ${rc}: ${stderr.slice(0, 200)}`,
        );
      }
      resolve(rc ?? -1);
    });
  });

  if (code !== 0) {
    await unlink(tmpPath).catch(() => undefined);
    return null;
  }

  // Verify the output is non-empty before overwriting. ffmpeg sometimes
  // emits a 0-byte file on edge cases (e.g. pure-silence input).
  let trimmedSize = 0;
  try {
    const s = await stat(tmpPath);
    trimmedSize = s.size;
  } catch {
    return null;
  }
  if (trimmedSize === 0) {
    await unlink(tmpPath).catch(() => undefined);
    return null;
  }

  try {
    await rename(tmpPath, audioPath);
    return trimmedSize;
  } catch (err) {
    console.warn("[tts] silence-trim rename failed", err);
    await unlink(tmpPath).catch(() => undefined);
    return null;
  }
}

/** Fire-and-forget silence trim. The caller doesn't await this — the
 *  cache row is still upserted with the pre-trim size; subsequent
 *  cache hits read the trimmed file from disk. Tolerates concurrent
 *  trims (rename-on-tmp is atomic). */
export function scheduleSilenceTrim(
  audioPath: string,
  db: Database | null,
  cacheKey: string,
): void {
  if (!env.TTS_SILENCE_TRIM) return;
  void (async () => {
    const newSize = await trimSilenceInPlace(audioPath);
    if (newSize === null) return;
    if (!db) return;
    // Update the cached size so the row matches disk reality. Skip on
    // failure — the size mismatch is an analytics issue, not a
    // correctness one.
    try {
      await db
        .update(schema.ttsCache)
        .set({ bytes: newSize })
        .where(eq(schema.ttsCache.cacheKey, cacheKey));
    } catch (err) {
      console.warn("[tts] silence-trim size update failed", err);
    }
  })();
}

export type CacheHit = {
  cacheKey: string;
  voiceId: string;
  audioPath: string;
  durationMs: number;
  bytes: number;
};

export async function cacheLookup(
  db: Database,
  key: string,
): Promise<CacheHit | null> {
  assertCacheKey(key);
  const rows = await db
    .select({
      cacheKey: schema.ttsCache.cacheKey,
      voiceId: schema.ttsCache.voiceId,
      audioPath: schema.ttsCache.audioPath,
      durationMs: schema.ttsCache.durationMs,
      bytes: schema.ttsCache.bytes,
    })
    .from(schema.ttsCache)
    .where(eq(schema.ttsCache.cacheKey, key))
    .limit(1);
  return rows[0] ?? null;
}

export async function cacheStore(
  db: Database,
  args: {
    cacheKey: string;
    voiceId: string;
    textHash: string;
    audio: Buffer;
    durationMs: number;
  },
): Promise<{ audioPath: string; bytes: number }> {
  assertVoiceId(args.voiceId);
  assertCacheKey(args.cacheKey);

  const audioPath = cachePath(args.voiceId, args.cacheKey);
  const dir = path.dirname(audioPath);
  await mkdir(dir, { recursive: true });

  // Atomic write: tmp + rename so partial writes never appear under the
  // canonical name. Two concurrent writers for the same key both produce
  // identical bytes (content-addressed), so the rename race is benign.
  const tmpPath = `${audioPath}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(tmpPath, args.audio);
    await rename(tmpPath, audioPath);
  } catch (err) {
    await unlink(tmpPath).catch(() => undefined);
    throw err;
  }

  const bytes = args.audio.byteLength;
  await db
    .insert(schema.ttsCache)
    .values({
      cacheKey: args.cacheKey,
      voiceId: args.voiceId,
      textHash: args.textHash,
      audioPath,
      durationMs: args.durationMs,
      bytes,
    })
    .onConflictDoNothing();

  // Background silence trim — overwrites the file in place once the
  // ffmpeg pass completes. Doesn't block the caller; future cache
  // hits read the trimmed bytes.
  scheduleSilenceTrim(audioPath, db, args.cacheKey);

  return { audioPath, bytes };
}

// Tee a streaming Opus body — pass through to the client while
// simultaneously streaming the bytes to a tmp file in the cache dir.
// On stream end we fsync (best-effort) and atomically rename into the
// canonical cache path, then upsert the tts_cache row. Streaming
// straight to disk avoids holding the full Opus payload in heap during
// concurrent prerender bursts (each stream is 20-150KB but the buffering
// is unnecessary). Keeps the streaming-fast-cold-path AND the
// cache-hit-fast-path without forcing a serialize-then-stream detour.
export function teeForCache(
  db: Database,
  args: {
    cacheKey: string;
    voiceId: string;
    textHash: string;
    durationMs: number;
    source: ReadableStream<Uint8Array>;
  },
): ReadableStream<Uint8Array> {
  assertVoiceId(args.voiceId);
  assertCacheKey(args.cacheKey);

  const [forClient, forCache] = args.source.tee();

  void (async () => {
    const audioPath = cachePath(args.voiceId, args.cacheKey);
    const dir = path.dirname(audioPath);
    try {
      await mkdir(dir, { recursive: true });
    } catch (err) {
      console.warn("[tts] cache dir mkdir failed; not caching", err);
      return;
    }

    // Tmp lives in the same directory as the final path so rename is on
    // the same filesystem (atomic on POSIX). Two concurrent writers for
    // the same key both produce identical bytes (content-addressed), so
    // a rename race is benign — the loser unlinks its tmp and treats it
    // as a hit.
    const rand = crypto.randomBytes(3).toString("hex");
    const tmpPath = `${audioPath}.${process.pid}.${rand}.tmp`;

    const reader = forCache.getReader();
    const out = createWriteStream(tmpPath);
    let total = 0;
    let writeErr: unknown = null;

    out.on("error", (err) => {
      writeErr = err;
    });

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value || value.byteLength === 0) continue;
        if (writeErr) throw writeErr;
        const ok = out.write(value);
        total += value.byteLength;
        if (!ok) {
          await new Promise<void>((resolve, reject) => {
            const onDrain = () => {
              out.off("error", onError);
              resolve();
            };
            const onError = (err: Error) => {
              out.off("drain", onDrain);
              reject(err);
            };
            out.once("drain", onDrain);
            out.once("error", onError);
          });
        }
      }
    } catch (err) {
      console.warn("[tts] tee read failed; not caching", err);
      out.destroy();
      await unlink(tmpPath).catch(() => undefined);
      return;
    }

    try {
      await new Promise<void>((resolve, reject) => {
        out.end((err?: Error | null) => {
          if (err) reject(err);
          else if (writeErr) reject(writeErr);
          else resolve();
        });
      });
    } catch (err) {
      console.warn("[tts] tee write failed; not caching", err);
      await unlink(tmpPath).catch(() => undefined);
      return;
    }

    if (total === 0) {
      // upstream produced nothing — don't cache empty
      await unlink(tmpPath).catch(() => undefined);
      return;
    }

    // Best-effort fsync so the rename publishes durable bytes. If the
    // platform/fs doesn't support it we still proceed — the rename is
    // the correctness boundary, fsync is just durability hardening.
    try {
      const fh = await open(tmpPath, "r+");
      try {
        await fh.sync();
      } finally {
        await fh.close();
      }
    } catch {
      // ignore — fsync is best-effort
    }

    try {
      await rename(tmpPath, audioPath);
    } catch (err) {
      // If the destination already exists (concurrent writer beat us),
      // the bytes are content-identical. Drop our tmp and proceed to
      // the DB upsert as if we won. EEXIST surfaces on Windows; on
      // POSIX rename overwrites silently, so this branch is mainly a
      // belt-and-suspenders guard.
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "EEXIST" || code === "ENOTEMPTY") {
        await unlink(tmpPath).catch(() => undefined);
      } else {
        console.warn("[tts] tee rename failed; not caching", err);
        await unlink(tmpPath).catch(() => undefined);
        return;
      }
    }

    try {
      await db
        .insert(schema.ttsCache)
        .values({
          cacheKey: args.cacheKey,
          voiceId: args.voiceId,
          textHash: args.textHash,
          audioPath,
          durationMs: args.durationMs,
          bytes: total,
        })
        .onConflictDoNothing();
    } catch (err) {
      console.warn("[tts] cacheStore from tee failed", err);
    }

    // Background silence trim. Note: the response stream the client
    // already consumed wasn't trimmed — this only affects future
    // cache hits. The first listener pays a few ms of leading
    // silence; everyone after gets the trimmed version.
    scheduleSilenceTrim(audioPath, db, args.cacheKey);
  })();

  return forClient;
}

export async function cacheTouch(db: Database, key: string): Promise<void> {
  assertCacheKey(key);
  await db
    .update(schema.ttsCache)
    .set({ lastHitAt: sql`now()` })
    .where(eq(schema.ttsCache.cacheKey, key));
}

export async function audioFileSize(audioPath: string): Promise<number | null> {
  try {
    const s = await stat(audioPath);
    return s.size;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

export function streamAudioFile(audioPath: string): ReadableStream {
  const node = createReadStream(audioPath);
  return Readable.toWeb(node) as ReadableStream;
}
