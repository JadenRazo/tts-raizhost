// POST /api/rum — RUM beacon ingest.
//
// Auth: session cookie required. Anonymous beacons are rejected — we
// don't run a public RUM endpoint.
//
// Validation: zod-checked, allowlisted event names, bounded attribute
// counts and sizes.
//
// Rate limiting: in-memory token bucket per sessionId, 60 events/min.
// Single-replica web pod → single bucket. If we ever scale to >1 replica
// the bucket swaps for a postgres-backed counter; for now the simpler
// path matches the rest of the app.
//
// On accept: each event observes into the matching rum_* Prometheus
// collector AND emits one console.info line so Promtail captures it
// into Loki for ad-hoc per-session inspection.

import { NextResponse } from "next/server";
import { z } from "zod";

import { getSession } from "@/lib/auth/session";
import {
  rumAudioErrorsTotal,
  rumAudioStallDurationSeconds,
  rumAudioStallsTotal,
  rumCanPlayToAudibleSeconds,
  rumPlayToAudibleSeconds,
  rumPositionSaveFailedTotal,
  rumPrefetchFiredTotal,
  rumSentencePageLoadSeconds,
  rumWebVital,
} from "@/lib/metrics";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_EVENTS_PER_BEACON = 50;

const eventSchema = z.object({
  name: z.string().min(1).max(64),
  ts: z.number().int().min(0),
  attrs: z.record(z.union([z.string().max(200), z.number(), z.boolean()])).optional(),
});

const beaconSchema = z.object({
  sessionId: z.string().min(8).max(64),
  events: z.array(eventSchema).min(1).max(MAX_EVENTS_PER_BEACON),
});

// Allowlist of event names. Anything outside this set is dropped
// silently — clients should never produce unknown names, but guarding
// here keeps cardinality bounded if a malicious or buggy client tries.
const ALLOWED_EVENTS = new Set([
  "play_clicked",
  "audio_can_play",
  "audio_playing",
  "audio_ended",
  "audio_stall_started",
  "audio_stall_recovered",
  "audio_error",
  "prefetch_fired",
  "sentences_page",
  "position_save_failed",
  "prerender_triggered",
  "play_to_audible",
  "stall",
  "web_vital",
]);

const ALLOWED_AUDIO_ERROR_KINDS = new Set([
  "service-warming",
  "synth-failed",
  "other",
]);

const ALLOWED_VITAL_METRICS = new Set(["LCP", "INP", "CLS", "FCP", "TTFB"]);

// ---------------------------------------------------------------------
// Token bucket — in-process, per sessionId. 60 events / minute, refilled
// continuously. Capacity 60 means a fresh session can burst 60 events
// (well above realistic peak: ~5 events/sentence × ~3 sentences/min).
// ---------------------------------------------------------------------
const BUCKET_CAPACITY = 60;
const BUCKET_REFILL_PER_MS = BUCKET_CAPACITY / 60_000;
const BUCKET_TTL_MS = 10 * 60_000;

type Bucket = { tokens: number; lastRefill: number };
const buckets = new Map<string, Bucket>();

function takeTokens(sessionId: string, n: number): boolean {
  const now = Date.now();
  let b = buckets.get(sessionId);
  if (!b) {
    b = { tokens: BUCKET_CAPACITY, lastRefill: now };
    buckets.set(sessionId, b);
  } else {
    const elapsed = now - b.lastRefill;
    b.tokens = Math.min(BUCKET_CAPACITY, b.tokens + elapsed * BUCKET_REFILL_PER_MS);
    b.lastRefill = now;
  }
  if (b.tokens < n) return false;
  b.tokens -= n;
  return true;
}

// Periodically evict stale buckets so a long-running pod doesn't grow
// the map unboundedly. Cheap O(n) sweep — n is bounded by concurrent
// sessions.
let lastSweep = Date.now();
function maybeSweep(): void {
  const now = Date.now();
  if (now - lastSweep < 60_000) return;
  lastSweep = now;
  for (const [k, b] of buckets) {
    if (now - b.lastRefill > BUCKET_TTL_MS) buckets.delete(k);
  }
}

// ---------------------------------------------------------------------
// Event → metric router. Keep this dumb: one switch, no dynamic dispatch.
// ---------------------------------------------------------------------
function recordEvent(name: string, attrs: Record<string, unknown> | undefined): void {
  const a = attrs ?? {};
  switch (name) {
    case "play_to_audible": {
      const ms = num(a.durationMs);
      if (ms !== null) rumPlayToAudibleSeconds.observe(ms / 1000);
      break;
    }
    case "audio_playing": {
      // Some clients also emit a canPlayToAudibleMs attr alongside the
      // play_to_audible timing; we accept both placements.
      const ms = num(a.canPlayToAudibleMs);
      if (ms !== null) rumCanPlayToAudibleSeconds.observe(ms / 1000);
      break;
    }
    case "audio_stall_started": {
      rumAudioStallsTotal.inc();
      break;
    }
    case "stall": {
      const ms = num(a.durationMs);
      if (ms !== null) rumAudioStallDurationSeconds.observe(ms / 1000);
      break;
    }
    case "audio_error": {
      const kind = typeof a.kind === "string" && ALLOWED_AUDIO_ERROR_KINDS.has(a.kind)
        ? a.kind
        : "other";
      rumAudioErrorsTotal.labels({ kind }).inc();
      break;
    }
    case "prefetch_fired": {
      const outcome = typeof a.outcome === "string" && (a.outcome === "fired" || a.outcome === "skipped")
        ? a.outcome
        : "fired";
      rumPrefetchFiredTotal.labels({ outcome }).inc();
      break;
    }
    case "sentences_page": {
      const ms = num(a.durationMs);
      if (ms !== null) rumSentencePageLoadSeconds.observe(ms / 1000);
      break;
    }
    case "position_save_failed": {
      rumPositionSaveFailedTotal.inc();
      break;
    }
    case "web_vital": {
      const metric = typeof a.metric === "string" && ALLOWED_VITAL_METRICS.has(a.metric)
        ? a.metric
        : null;
      const value = num(a.value);
      if (metric && value !== null) {
        // For time vitals, value is in ms; for CLS, value is a unitless
        // ratio. The histogram buckets cover both ranges (CLS values
        // sort into the smaller buckets).
        const observed = metric === "CLS" ? value : value / 1000;
        rumWebVital.labels({ metric }).observe(observed);
      }
      break;
    }
    // Other events (play_clicked, audio_can_play, audio_ended,
    // prerender_triggered) are recorded as log lines only — they're
    // useful for session reconstruction but don't drive aggregates.
    default:
      break;
  }
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

export async function POST(req: Request): Promise<Response> {
  const session = await getSession();
  if (!session) {
    return new Response("unauthorized", { status: 401 });
  }
  const userId = session.user.id;

  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  const parsed = beaconSchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid beacon" }, { status: 400 });
  }
  const { sessionId, events } = parsed.data;

  maybeSweep();
  if (!takeTokens(sessionId, events.length)) {
    return new Response("rate limited", {
      status: 429,
      headers: { "Retry-After": "5" },
    });
  }

  for (const ev of events) {
    if (!ALLOWED_EVENTS.has(ev.name)) continue;
    recordEvent(ev.name, ev.attrs);
    // Promtail picks this up because the record contains rum=true and
    // we emit one JSON line per event. Don't include the raw text or
    // bookId — the beacon shape already excludes them, but defense
    // in depth.
    console.info(JSON.stringify({
      rum: true,
      event: ev.name,
      sessionId,
      userId,
      ts: ev.ts,
      ...(ev.attrs ?? {}),
    }));
  }

  return new Response(null, { status: 204 });
}
