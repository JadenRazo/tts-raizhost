// PUT /api/users/me/settings — upsert the caller's voice + speed preferences.
//
// Body: { voiceId?: string, speed?: number }
// Both fields optional; only the supplied keys are written. Returns 204.

import { sql } from "drizzle-orm";
import { NextResponse } from "next/server";
import { z } from "zod";

import { getSession } from "@/lib/auth/session";
import { getDb, schema } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// voiceId pattern matches Piper's id format (e.g. en_US-lessac-high).
// Speed clamp matches the reader's picker range.
const bodySchema = z
  .object({
    voiceId: z
      .string()
      // Piper voice IDs: <lang>_<COUNTRY>-<name>-<quality>, e.g.
      // en_US-lessac-high, en_GB-jenny_dioco-medium.
      .regex(/^[a-z]{2}_[A-Z]{2}-[a-z][a-z0-9_]*-[a-z]+$/, "Invalid voiceId")
      .optional(),
    speed: z.number().min(0.5).max(2.0).optional(),
  })
  .refine(
    (v) => v.voiceId !== undefined || v.speed !== undefined,
    "Provide voiceId or speed",
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
  const { voiceId, speed } = parsed.data;

  const db = getDb();

  // Insert path uses the schema defaults for any field the caller omitted;
  // update path only writes the supplied keys, so a speed-only PUT doesn't
  // clobber a previously-set voice.
  const updateSet: Record<string, unknown> = { updatedAt: sql`now()` };
  if (voiceId !== undefined) updateSet.voiceId = voiceId;
  if (speed !== undefined) updateSet.speed = speed;

  await db
    .insert(schema.userSettings)
    .values({
      userId,
      ...(voiceId !== undefined ? { voiceId } : {}),
      ...(speed !== undefined ? { speed } : {}),
    })
    .onConflictDoUpdate({
      target: schema.userSettings.userId,
      set: updateSet,
    });

  return new Response(null, { status: 204 });
}
