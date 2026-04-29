// Library limits + per-user usage helpers. Single source of truth for the
// per-user 5-book / 50 MB-per-file caps so client and server quote identical
// numbers. The total per-user cap derives from the two: 5 × 50 MB = 250 MB.

import { eq, sql } from "drizzle-orm";
import type { Database } from "@/lib/db";
import * as schema from "@/lib/db/schema";

export const MAX_FILE_BYTES = 50 * 1024 * 1024;
export const MAX_BOOKS_PER_USER = 5;
export const MAX_TOTAL_BYTES = MAX_FILE_BYTES * MAX_BOOKS_PER_USER;

export type LimitErrorCode =
  | "BOOK_LIMIT"
  | "FILE_TOO_LARGE"
  | "STORAGE_LIMIT";

export class LimitExceededError extends Error {
  readonly code: LimitErrorCode;
  readonly status: number;
  constructor(code: LimitErrorCode, message: string) {
    super(message);
    this.name = "LimitExceededError";
    this.code = code;
    this.status = code === "FILE_TOO_LARGE" ? 413 : 409;
  }
}

export async function getUserBookCount(
  db: Database,
  userId: string,
): Promise<number> {
  const rows = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(schema.books)
    .where(eq(schema.books.userId, userId));
  return rows[0]?.count ?? 0;
}

export async function getUserStorageUsed(
  db: Database,
  userId: string,
): Promise<number> {
  const rows = await db
    .select({ total: sql<number>`coalesce(sum(${schema.books.byteSize}), 0)::bigint` })
    .from(schema.books)
    .where(eq(schema.books.userId, userId));
  // bigint comes back as string from pg; coerce.
  const raw = rows[0]?.total;
  return typeof raw === "string" ? Number(raw) : (raw ?? 0);
}

export async function getUserUsage(
  db: Database,
  userId: string,
): Promise<{ count: number; bytes: number }> {
  const rows = await db
    .select({
      count: sql<number>`count(*)::int`,
      total: sql<number>`coalesce(sum(${schema.books.byteSize}), 0)::bigint`,
    })
    .from(schema.books)
    .where(eq(schema.books.userId, userId));
  const r = rows[0];
  const total = r?.total;
  return {
    count: r?.count ?? 0,
    bytes: typeof total === "string" ? Number(total) : (total ?? 0),
  };
}

/**
 * Pre-flight check used by the upload route before writing to disk. The
 * authoritative cap enforcement happens inside the upload's serializable
 * transaction (see books/route.ts) — this exists to short-circuit obvious
 * rejections without spending disk on a doomed write.
 */
export async function assertWithinLimits(
  db: Database,
  userId: string,
  fileBytes: number,
): Promise<void> {
  if (fileBytes > MAX_FILE_BYTES) {
    throw new LimitExceededError(
      "FILE_TOO_LARGE",
      `File exceeds the ${Math.round(MAX_FILE_BYTES / 1024 / 1024)} MB per-file limit.`,
    );
  }
  const usage = await getUserUsage(db, userId);
  if (usage.count >= MAX_BOOKS_PER_USER) {
    throw new LimitExceededError(
      "BOOK_LIMIT",
      "Storage limit reached. Delete a book to upload another.",
    );
  }
  if (usage.bytes + fileBytes > MAX_TOTAL_BYTES) {
    throw new LimitExceededError(
      "STORAGE_LIMIT",
      `Total storage cap of ${Math.round(MAX_TOTAL_BYTES / 1024 / 1024)} MB would be exceeded.`,
    );
  }
}
