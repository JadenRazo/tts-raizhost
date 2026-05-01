// GET /api/invites/check?code=<code>
//
// Lightweight pre-check used by the signup page to decide whether to
// render the form. Returns 200 { valid: true } if the code exists and is
// unconsumed, 404 otherwise. Does NOT consume the code — that happens
// atomically inside the signUp transaction.

import { sql } from "drizzle-orm";
import { NextResponse } from "next/server";

import { getDb, schema } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const code = url.searchParams.get("code")?.trim() ?? "";
  if (!code || code.length > 64) {
    return NextResponse.json({ valid: false }, { status: 404 });
  }
  const db = getDb();
  const rows = await db
    .select({
      code: schema.inviteCodes.code,
      useCount: schema.inviteCodes.useCount,
      maxUses: schema.inviteCodes.maxUses,
    })
    .from(schema.inviteCodes)
    .where(
      sql`${schema.inviteCodes.code} = ${code} AND ${schema.inviteCodes.useCount} < ${schema.inviteCodes.maxUses}`,
    )
    .limit(1);
  if (rows.length === 0) {
    return NextResponse.json({ valid: false }, { status: 404 });
  }
  return NextResponse.json(
    {
      valid: true,
      remaining: rows[0].maxUses - rows[0].useCount,
    },
    {
      status: 200,
      headers: { "cache-control": "no-store" },
    },
  );
}
