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

import crypto from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { eq, sql } from "drizzle-orm";

import type { Database } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { env } from "@/lib/env";

const VOICE_ID_RE = /^[a-z]{2}_[A-Z]{2}-[a-z][a-z0-9_]*-[a-z]+$/;
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

  return { audioPath, bytes };
}

// Tee a streaming Opus body — pass through to the client while
// simultaneously buffering the bytes in memory. After the stream
// completes (or errors) we persist the buffered bytes to disk and the
// tts_cache row, identical in shape to the non-streaming `cacheStore`
// path. Keeps the streaming-fast-cold-path AND the cache-hit-fast-path
// without forcing a serialize-then-stream detour.
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
    const reader = forCache.getReader();
    const chunks: Uint8Array[] = [];
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) chunks.push(value);
      }
    } catch (err) {
      console.warn("[tts] tee read failed; not caching", err);
      return;
    }

    let total = 0;
    for (const c of chunks) total += c.byteLength;
    if (total === 0) return; // upstream produced nothing — don't cache empty

    const audio = Buffer.concat(chunks.map((c) => Buffer.from(c)), total);
    try {
      await cacheStore(db, {
        cacheKey: args.cacheKey,
        voiceId: args.voiceId,
        textHash: args.textHash,
        audio,
        durationMs: args.durationMs,
      });
    } catch (err) {
      console.warn("[tts] cacheStore from tee failed", err);
    }
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
