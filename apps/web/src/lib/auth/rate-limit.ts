// Per-process in-memory rate limiter. Sufficient for single-replica
// production; if we scale to multiple replicas, swap the Map for Redis.

type Bucket = { count: number; resetAt: number };

const WINDOW_MS = 5 * 60 * 1000;
const MAX_PER_WINDOW = 5;

const buckets = new Map<string, Bucket>();

function gc() {
  const now = Date.now();
  for (const [k, b] of buckets) {
    if (b.resetAt < now) buckets.delete(k);
  }
}

export type LimitResult = {
  ok: boolean;
  remaining: number;
  resetAt: number;
};

export function check(key: string, max: number = MAX_PER_WINDOW): LimitResult {
  if (buckets.size > 10_000) gc();
  const now = Date.now();
  const b = buckets.get(key);
  if (!b || b.resetAt < now) {
    const fresh = { count: 1, resetAt: now + WINDOW_MS };
    buckets.set(key, fresh);
    return { ok: true, remaining: max - 1, resetAt: fresh.resetAt };
  }
  if (b.count >= max) {
    return { ok: false, remaining: 0, resetAt: b.resetAt };
  }
  b.count += 1;
  return { ok: true, remaining: max - b.count, resetAt: b.resetAt };
}

export function reset(key: string): void {
  buckets.delete(key);
}

/**
 * Compose two keys (IP and username) so a single request consumes from
 * both buckets. Returns the more-restrictive ok=false if either is exhausted.
 */
export function checkLogin(ip: string, username: string): LimitResult {
  const ipResult = check(`ip:${ip}`);
  const userResult = check(`user:${username.toLowerCase()}`);
  if (!ipResult.ok || !userResult.ok) {
    return ipResult.ok ? userResult : ipResult;
  }
  return {
    ok: true,
    remaining: Math.min(ipResult.remaining, userResult.remaining),
    resetAt: Math.max(ipResult.resetAt, userResult.resetAt),
  };
}

export function resetLogin(ip: string, username: string): void {
  reset(`ip:${ip}`);
  reset(`user:${username.toLowerCase()}`);
}
