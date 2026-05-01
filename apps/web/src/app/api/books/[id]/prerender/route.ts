// POST /api/books/:id/prerender
//
// Kicks off a background job that synthesizes every sentence in the
// book at the given (voice, speed) and persists each to the audio
// cache. After a job finishes successfully, every audio request for
// that (book, voice, speed) is a cache hit and the user never waits
// for kokoro again.
//
// Response shape:
//   { status: "complete" | "queued" | "in_progress",
//     prerenderedAt?: string }
//
// 200 — status="complete". This (book, voice, speed) was already
//       prerendered on a prior pod. `prerenderedAt` is the ISO-8601
//       timestamp from book_prerender_runs.prerendered_at.
// 202 — status="queued" (we just started a new job) or "in_progress"
//       (a job for the same triple is already running on this pod).
//
// Idempotent: persistent state lives in the book_prerender_runs
// table; the in-process inflight Map is a same-pod dedup on top.

import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { z } from "zod";

import { getSession } from "@/lib/auth/session";
import { userCanReadBook } from "@/lib/books";
import { getDb, schema } from "@/lib/db";
import { isUuid } from "@/lib/storage";
import {
  getPrerenderRun,
  isPrerenderInflight,
  prerenderBook,
} from "@/lib/tts-prerender";
import { ALLOWED_VOICES } from "@/lib/voices";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.object({
  voice: z.string().refine((v) => ALLOWED_VOICES.has(v), "Unknown voice"),
  // Mirrors apps/web/src/app/api/tts/route.ts:ALLOWED_SPEEDS. A prerender
  // run at a speed the live path won't accept produces unusable cache
  // entries, so we keep the validation identical at both edges.
  speed: z.number().refine(
    (v) => [0.75, 1.0, 1.25, 1.5].includes(Math.round(v * 100) / 100),
    "Unsupported speed",
  ),
});

type RouteContext = { params: Promise<{ id: string }> };

export async function POST(req: Request, { params }: RouteContext) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id: bookId } = await params;
  if (!isUuid(bookId)) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const parsed = bodySchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid body" },
      { status: 400 },
    );
  }
  const { voice, speed } = parsed.data;
  const speedQuantized = Math.round(speed * 100) / 100;

  const db = getDb();
  const owned = await db
    .select({ id: schema.books.id })
    .from(schema.books)
    .where(and(eq(schema.books.id, bookId), userCanReadBook(session.user.id)))
    .limit(1);
  if (owned.length === 0) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  // Cross-pod short-circuit: if the persistent table records this
  // (book, voice, speed) as already complete, return 200 immediately
  // and skip the sentence walk entirely. This is the whole reason the
  // table exists — without it, every reader on a fresh pod re-walks
  // ~4500 sentences against the cache before realizing it's a no-op.
  const existingRun = await getPrerenderRun(
    db,
    bookId,
    voice,
    speedQuantized,
  );
  if (existingRun?.status === "complete") {
    return NextResponse.json(
      {
        status: "complete" as const,
        prerenderedAt: existingRun.prerenderedAt?.toISOString(),
      },
      { status: 200 },
    );
  }

  const alreadyInflight = isPrerenderInflight(bookId, voice, speedQuantized);

  // Fire-and-forget. The prerender helper deduplicates concurrent
  // requests for the same (book, voice, speed) so a second click on
  // the same combination just attaches to the running job.
  void prerenderBook(db, bookId, voice, speedQuantized)
    .then((stats) => {
      console.info("[prerender] complete", stats);
    })
    .catch((err) => {
      console.error("[prerender] failed", {
        bookId,
        voice,
        speed: speedQuantized,
        err: err instanceof Error ? err.message : String(err),
      });
    });

  return NextResponse.json(
    { status: alreadyInflight ? "in_progress" : "queued" },
    { status: 202 },
  );
}
