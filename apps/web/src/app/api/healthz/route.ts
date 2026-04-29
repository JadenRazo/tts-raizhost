// Liveness/readiness endpoint. Two checks:
//   1. Postgres ping (db.execute(`select 1`)) — 500ms budget.
//   2. Kokoro /healthz reachability — 500ms budget.
//
// Default response is shallow: `{ ok: true }` after both probes pass.
// `?deep=1` returns the upstream JSON so an operator can inspect.

import { sql } from "drizzle-orm";

import { getDb } from "@/lib/db";
import { env } from "@/lib/env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DB_BUDGET_MS = 500;
const KOKORO_BUDGET_MS = 500;

export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const deep = url.searchParams.get("deep") === "1";

  const [dbResult, kokoroResult] = await Promise.all([
    checkDb(),
    checkKokoro(),
  ]);

  const ok = dbResult.ok && kokoroResult.ok;
  const body = deep
    ? { ok, db: dbResult, kokoro: kokoroResult }
    : { ok };

  return new Response(JSON.stringify(body), {
    status: ok ? 200 : 503,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

async function checkDb(): Promise<{ ok: boolean; error?: string }> {
  try {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), DB_BUDGET_MS);
    try {
      await Promise.race([
        getDb().execute(sql`select 1`),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("db timeout")), DB_BUDGET_MS),
        ),
      ]);
      return { ok: true };
    } finally {
      clearTimeout(timer);
    }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "unknown" };
  }
}

async function checkKokoro(): Promise<{ ok: boolean; modelLoaded?: boolean; error?: string }> {
  try {
    const res = await fetch(`${env.KOKORO_URL}/healthz`, {
      signal: AbortSignal.timeout(KOKORO_BUDGET_MS),
    });
    if (!res.ok) return { ok: false, error: `kokoro ${res.status}` };
    const body = (await res.json()) as { ok?: boolean; model_loaded?: boolean };
    return { ok: !!body.ok, modelLoaded: body.model_loaded };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "unknown" };
  }
}
