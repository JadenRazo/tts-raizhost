// DELETE /api/books/:id/bookmarks/:bookmarkId
// PATCH  /api/books/:id/bookmarks/:bookmarkId  <- { note }
//
// Only the bookmark's owner can mutate it; ownership is enforced by
// the user_id filter in the WHERE.

import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { z } from "zod";

import { getSession } from "@/lib/auth/session";
import { getDb, schema } from "@/lib/db";
import { isUuid } from "@/lib/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = {
  params: Promise<{ id: string; bookmarkId: string }>;
};

const patchSchema = z.object({
  note: z.string().max(500).nullable(),
});

export async function DELETE(_req: Request, { params }: RouteContext) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { id: bookId, bookmarkId } = await params;
  if (!isUuid(bookId) || !isUuid(bookmarkId)) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const userId = session.user.id;

  const db = getDb();
  const result = await db
    .delete(schema.bookmarks)
    .where(
      and(
        eq(schema.bookmarks.id, bookmarkId),
        eq(schema.bookmarks.userId, userId),
        eq(schema.bookmarks.bookId, bookId),
      ),
    )
    .returning({ id: schema.bookmarks.id });

  if (result.length === 0) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  return new Response(null, { status: 204 });
}

export async function PATCH(req: Request, { params }: RouteContext) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { id: bookId, bookmarkId } = await params;
  if (!isUuid(bookId) || !isUuid(bookmarkId)) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const userId = session.user.id;

  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const parsed = patchSchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid body" },
      { status: 400 },
    );
  }

  const db = getDb();
  const result = await db
    .update(schema.bookmarks)
    .set({ note: parsed.data.note })
    .where(
      and(
        eq(schema.bookmarks.id, bookmarkId),
        eq(schema.bookmarks.userId, userId),
        eq(schema.bookmarks.bookId, bookId),
      ),
    )
    .returning({ id: schema.bookmarks.id });

  if (result.length === 0) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  return new Response(null, { status: 204 });
}
