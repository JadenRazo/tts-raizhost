// Real User Monitoring (RUM) — client-side beacon module.
//
// Captures three event kinds:
//   - rum.event(name, attrs?)         single event with optional attributes
//   - rum.timing.start(name)/end(name)  open/close a timing mark; on end,
//                                       a single event named `<name>` is
//                                       emitted with attrs.durationMs set.
//   - rum.vital(metric)               a web-vitals callback (LCP/INP/CLS/FCP/TTFB).
//
// Events are queued in memory and flushed to /api/rum via sendBeacon
// (fall back to keepalive fetch when sendBeacon refuses, e.g. when the
// payload exceeds the browser's 64KB beacon cap, which we cap below).
//
// Tab-scoped session: the sessionId is a per-page-load uuid. Server
// adds the authenticated userId from the cookie session — no PII goes
// over the wire from the browser.
//
// Cardinality discipline: event names are an allowlist on the server;
// unknown names are dropped silently. Attribute keys/values are bounded
// in size.

import { getCurrentTraceContext } from "./trace-context";

const QUEUE_MAX = 50;
const FLUSH_THRESHOLD = 10;
const FLUSH_INTERVAL_MS = 5_000;
const BEACON_PATH = "/api/rum";

type AttrValue = string | number | boolean;
type Attrs = Record<string, AttrValue>;

type RumEvent = {
  name: string;
  ts: number;
  attrs?: Attrs;
};

type RumState = {
  sessionId: string;
  queue: RumEvent[];
  marks: Map<string, number>;
  intervalId: ReturnType<typeof setInterval> | null;
};

declare global {
  interface Window {
    __ttsRum?: RumState;
  }
}

function getState(): RumState | null {
  if (typeof window === "undefined") return null;
  if (!window.__ttsRum) {
    window.__ttsRum = {
      sessionId: typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : Math.random().toString(36).slice(2),
      queue: [],
      marks: new Map(),
      intervalId: null,
    };
    installFlushHooks(window.__ttsRum);
  }
  return window.__ttsRum;
}

function installFlushHooks(state: RumState): void {
  // Periodic flush — keeps the dashboard responsive during a long
  // reading session without waiting for tab close.
  state.intervalId = setInterval(() => flush(state), FLUSH_INTERVAL_MS);
  // visibilitychange→hidden and pagehide are the most reliable signals
  // that the tab is going away (mobile background, refresh, navigate).
  // sendBeacon survives those transitions; fetch usually doesn't.
  window.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flush(state);
  });
  window.addEventListener("pagehide", () => flush(state));
  window.addEventListener("beforeunload", () => flush(state));
}

function enqueue(state: RumState, event: RumEvent): void {
  if (state.queue.length >= QUEUE_MAX) {
    state.queue.shift();
  }
  state.queue.push(event);
  if (state.queue.length >= FLUSH_THRESHOLD) {
    flush(state);
  }
}

function flush(state: RumState): void {
  if (state.queue.length === 0) return;
  const batch = state.queue.splice(0, state.queue.length);
  const body = JSON.stringify({ sessionId: state.sessionId, events: batch });

  const beacon = navigator.sendBeacon?.bind(navigator);
  if (beacon) {
    try {
      const blob = new Blob([body], { type: "application/json" });
      const ok = beacon(BEACON_PATH, blob);
      if (ok) return;
    } catch {
      // fall through to fetch
    }
  }
  // sendBeacon unavailable or rejected the payload (size cap, scheme).
  // keepalive: true allows the request to outlive the page if possible.
  void fetch(BEACON_PATH, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
    keepalive: true,
    credentials: "same-origin",
  }).catch(() => {});
}

function sanitizeAttrs(attrs: Attrs | undefined): Attrs | undefined {
  if (!attrs) return undefined;
  const out: Attrs = {};
  let count = 0;
  for (const [k, v] of Object.entries(attrs)) {
    if (count >= 16) break;
    if (typeof v === "string") {
      out[k] = v.length > 200 ? v.slice(0, 200) : v;
    } else if (typeof v === "number" && Number.isFinite(v)) {
      out[k] = v;
    } else if (typeof v === "boolean") {
      out[k] = v;
    } else {
      continue;
    }
    count++;
  }
  return out;
}

function event(name: string, attrs?: Attrs): void {
  const state = getState();
  if (!state) return;
  // Stamp the active W3C trace context so every event a dashboard
  // shows can be drilled into Tempo by trace_id. We log this only —
  // server-side keeps it out of Prometheus labels (cardinality).
  const trace = getCurrentTraceContext();
  const merged: Attrs | undefined = trace
    ? { ...(attrs ?? {}), trace_id: trace.traceId, span_id: trace.spanId }
    : attrs;
  enqueue(state, {
    name,
    ts: Date.now(),
    attrs: sanitizeAttrs(merged),
  });
}

const timing = {
  start(name: string): void {
    const state = getState();
    if (!state) return;
    state.marks.set(name, performance.now());
  },
  end(name: string, extraAttrs?: Attrs): number | null {
    const state = getState();
    if (!state) return null;
    const startedAt = state.marks.get(name);
    if (startedAt === undefined) return null;
    state.marks.delete(name);
    const durationMs = Math.round(performance.now() - startedAt);
    event(name, { ...(extraAttrs ?? {}), durationMs });
    return durationMs;
  },
  cancel(name: string): void {
    const state = getState();
    if (!state) return;
    state.marks.delete(name);
  },
  isOpen(name: string): boolean {
    const state = getState();
    if (!state) return false;
    return state.marks.has(name);
  },
};

// Web Vitals callback. The web-vitals library passes a Metric object
// with `name` (e.g. "LCP") and `value` (in ms for time vitals, unitless
// for CLS). We pass it straight through; the server route buckets it.
type WebVitalMetric = {
  name: string;
  value: number;
  id?: string;
  rating?: string;
};

function vital(metric: WebVitalMetric, route?: string): void {
  event("web_vital", {
    metric: metric.name,
    value: Math.round(metric.value * 1000) / 1000,
    rating: metric.rating ?? "unknown",
    route: route ?? "unknown",
  });
}

// Stack trace fingerprint. We don't ship raw stacks to the server (PII
// risk in URL paths, line numbers shift across builds anyway) — instead
// we hash the *shape* and send a 16-hex token the dashboard can group on.
function stackFingerprint(stack: string | undefined): string {
  if (!stack) return "no-stack";
  // Keep only function names + file basenames; drop line/col/origin.
  const normalized = stack
    .split("\n")
    .slice(0, 8)
    .map((l) => l.replace(/https?:\/\/[^)]+/g, "").replace(/:\d+:\d+/g, ""))
    .join("\n");
  // Tiny non-crypto hash — purpose is grouping, not security.
  let h = 0;
  for (let i = 0; i < normalized.length; i++) {
    h = (h * 31 + normalized.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

const KNOWN_ERROR_CLASSES = new Set([
  "TypeError",
  "ReferenceError",
  "SyntaxError",
  "RangeError",
  "URIError",
  "AbortError",
  "NetworkError",
  "Error",
]);

function classify(name: string | undefined): string {
  if (!name) return "Other";
  return KNOWN_ERROR_CLASSES.has(name) ? name : "Other";
}

// Manual error report. Used by the layout-level window.error /
// unhandledrejection listeners and by React error boundaries.
//
// Sanitization: bounded message length, fingerprint instead of raw
// stack, error_class restricted to a known allowlist. Route is the
// caller's responsibility (read from usePathname or the URL).
function error(
  err: unknown,
  ctx?: { route?: string; source?: string },
): void {
  const e = err instanceof Error ? err : null;
  const message = e?.message ?? (typeof err === "string" ? err : "Unknown");
  event("js_error", {
    error_class: classify(e?.name),
    message: message.slice(0, 300),
    stack_hash: stackFingerprint(e?.stack),
    route: ctx?.route ?? "unknown",
    source: ctx?.source ?? "manual",
  });
}

export const rum = { event, timing, vital, error };
export type { Attrs, WebVitalMetric };
