// Per-user daily TTS synthesis quota. Counts only cache-miss requests
// (cache hits cost no GPU time). The row is created lazily on first
// recordUsage; the daily reset CronJob zeroes chars_used_today at 00:00
// UTC across all rows.
//
// Mirrors the books.ts limit-error pattern so route handlers can let the
// throw bubble and convert to a JSON response in one place.

import { eq, sql } from "drizzle-orm";

import type { Database } from "@/lib/db";
import * as schema from "@/lib/db/schema";

export const DEFAULT_DAILY_LIMIT = 200_000;

export class QuotaExceededError extends Error {
  readonly status = 429;
  readonly used: number;
  readonly limit: number;
  constructor(used: number, limit: number) {
    super(
      `Daily TTS synthesis quota exceeded (${used} / ${limit} characters).`,
    );
    this.name = "QuotaExceededError";
    this.used = used;
    this.limit = limit;
  }
}

export type QuotaState = {
  used: number;
  limit: number;
};

export async function getQuota(
  db: Database,
  userId: string,
): Promise<QuotaState> {
  const rows = await db
    .select({
      used: schema.userTtsQuota.charsUsedToday,
      limit: schema.userTtsQuota.dailyLimit,
    })
    .from(schema.userTtsQuota)
    .where(eq(schema.userTtsQuota.userId, userId))
    .limit(1);
  const r = rows[0];
  if (!r) return { used: 0, limit: DEFAULT_DAILY_LIMIT };
  return { used: r.used, limit: r.limit };
}

/**
 * Pre-flight check used by the TTS cache-miss path. Throws
 * QuotaExceededError when the user is at or above their daily cap.
 *
 * Cheap read: a single indexed PK lookup. Race against another in-flight
 * synth from the same user is benign — `recordUsage` is the authoritative
 * counter, and a tiny over-spill (one extra synth) is acceptable.
 */
export async function assertQuota(
  db: Database,
  userId: string,
  charsRequested: number,
): Promise<QuotaState> {
  const state = await getQuota(db, userId);
  if (state.used + charsRequested > state.limit) {
    throw new QuotaExceededError(state.used, state.limit);
  }
  return state;
}

/**
 * Record cache-miss synthesis usage. Atomic upsert — first request for a
 * user inserts the row at the default limit; subsequent requests increment.
 * Returns the new used-today and limit so the caller can emit a header
 * (e.g. X-Quota-Remaining) without a second round-trip.
 */
export async function recordUsage(
  db: Database,
  userId: string,
  chars: number,
): Promise<QuotaState> {
  const [row] = await db
    .insert(schema.userTtsQuota)
    .values({
      userId,
      charsUsedToday: chars,
      totalCharsLifetime: chars,
    })
    .onConflictDoUpdate({
      target: schema.userTtsQuota.userId,
      set: {
        charsUsedToday: sql`${schema.userTtsQuota.charsUsedToday} + ${chars}`,
        totalCharsLifetime: sql`${schema.userTtsQuota.totalCharsLifetime} + ${chars}`,
      },
    })
    .returning({
      used: schema.userTtsQuota.charsUsedToday,
      limit: schema.userTtsQuota.dailyLimit,
    });
  if (!row) return { used: chars, limit: DEFAULT_DAILY_LIMIT };
  return { used: row.used, limit: row.limit };
}

/**
 * Used by the daily reset CronJob (deploy/k8s/cronjob-quota-reset.yaml).
 * Resets chars_used_today on every row whose last_reset_at is older than
 * 20 hours so a doubly-fired Job never double-resets a row.
 */
export async function resetAllDailyQuotas(db: Database): Promise<number> {
  const result = await db
    .update(schema.userTtsQuota)
    .set({
      charsUsedToday: 0,
      lastResetAt: new Date(),
    })
    .where(
      sql`${schema.userTtsQuota.lastResetAt} < now() - interval '20 hours'`,
    );
  return result.rowCount ?? 0;
}
