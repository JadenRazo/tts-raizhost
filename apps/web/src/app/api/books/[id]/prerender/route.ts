// POST /api/books/:id/prerender
//
// Kicks off a background job that synthesizes every sentence in the
// book at the given (voice, speed) and persists each to the audio
// cache. The endpoint returns immediately (HTTP 202) — the synth runs
// in the Next.js process for the rest of its life. After the job
// finishes, every audio request for that (book, voice, speed) is a
// cache hit and the user never waits for kokoro again.
//
// Idempotent: if a prerender for the same (book, voice, speed) is
// already in-flight, this attaches to it instead of starting a
// duplicate. Already-cached sentences are skipped.

import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { z } from "zod";

import { getSession } from "@/lib/auth/session";
import { getDb, schema } from "@/lib/db";
import { isUuid } from "@/lib/storage";
import { isPrerenderInflight, prerenderBook } from "@/lib/tts-prerender";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Keep in sync with services/kokoro/synth.py:VOICE_CATALOG and
// app/api/tts/route.ts:ALLOWED_VOICES.
const ALLOWED_VOICES = new Set<string>([
  "en_US-lessac-medium",
  "en_US-ryan-medium",
]);

const bodySchema = z.object({
  voice: z.string().refine((v) => ALLOWED_VOICES.has(v), "Unknown voice"),
  speed: z.number().min(0.5).max(2.0),
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
    .where(and(eq(schema.books.id, bookId), eq(schema.books.userId, session.user.id)))
    .limit(1);
  if (owned.length === 0) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
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
    { status: alreadyInflight ? "already-running" : "started" },
    { status: 202 },
  );
}
