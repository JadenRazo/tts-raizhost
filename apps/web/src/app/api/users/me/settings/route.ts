// PUT /api/users/me/settings — upsert the caller's reader preferences.
//
// Accepts any subset of:
//   - voiceId, speed
//   - nextTrackAction, prevTrackAction (CarPlay / Bluetooth track buttons)
//   - seekForwardAction, seekBackwardAction (CarPlay / Bluetooth seek pair)
//   - seekStepSeconds (5..120)
//   - smartRewindSeconds (0..60)
//   - sleepTimerDefaultMinutes (5..120)
//
// Only the supplied keys are written; defaults from the schema fill in
// the rest on first insert. Returns 204 on success.

import { sql } from "drizzle-orm";
import { NextResponse } from "next/server";
import { z } from "zod";

import { getSession } from "@/lib/auth/session";
import { getDb, schema } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Action enums must match the CHECK constraints on user_settings. The DB
// is the source of truth; if these drift, an UPDATE that passes zod will
// fail at INSERT time with a 23514. Keep them aligned.
const NEXT_TRACK_ACTIONS = [
  "next_sentence",
  "next_page",
  "next_chapter",
  "seek_forward",
  "restart_sentence",
] as const;
const PREV_TRACK_ACTIONS = [
  "prev_sentence",
  "prev_page",
  "prev_chapter",
  "seek_back",
  "restart_sentence",
  "restart_book",
] as const;
const SEEK_FORWARD_ACTIONS = [
  "seek_forward",
  "next_sentence",
  "next_page",
  "next_chapter",
] as const;
const SEEK_BACKWARD_ACTIONS = [
  "seek_back",
  "prev_sentence",
  "prev_page",
  "prev_chapter",
  "restart_sentence",
] as const;

const bodySchema = z
  .object({
    voiceId: z
      // Kokoro voice IDs: <lang_code><gender>_<name>, e.g.
      // af_heart, am_michael, bf_emma.
      .string()
      .regex(/^[a-z]{2}_[a-z][a-z0-9_]*$/, "Invalid voiceId")
      .optional(),
    speed: z.number().min(0.5).max(2.0).optional(),
    nextTrackAction: z.enum(NEXT_TRACK_ACTIONS).optional(),
    prevTrackAction: z.enum(PREV_TRACK_ACTIONS).optional(),
    seekForwardAction: z.enum(SEEK_FORWARD_ACTIONS).optional(),
    seekBackwardAction: z.enum(SEEK_BACKWARD_ACTIONS).optional(),
    seekStepSeconds: z.number().int().min(5).max(120).optional(),
    smartRewindSeconds: z.number().int().min(0).max(60).optional(),
    sleepTimerDefaultMinutes: z.number().int().min(5).max(120).optional(),
  })
  .refine(
    (v) => Object.values(v).some((x) => x !== undefined),
    "Provide at least one settings field",
  );

export async function PUT(req: Request) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const userId = session.user.id;

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
  const data = parsed.data;

  const db = getDb();

  // Insert path uses the schema defaults for any field the caller omitted;
  // update path only writes the supplied keys, so a single-field PUT
  // never clobbers other settings.
  const updateSet: Record<string, unknown> = { updatedAt: sql`now()` };
  const insertValues: Record<string, unknown> = { userId };
  for (const [key, value] of Object.entries(data)) {
    if (value === undefined) continue;
    updateSet[key] = value;
    insertValues[key] = value;
  }

  await db
    .insert(schema.userSettings)
    .values(insertValues as typeof schema.userSettings.$inferInsert)
    .onConflictDoUpdate({
      target: schema.userSettings.userId,
      set: updateSet,
    });

  return new Response(null, { status: 204 });
}
