// Lightweight W3C trace context for the browser. We deliberately avoid
// the OpenTelemetry browser SDK (~12 KB gzip + Zone.js dance) — for our
// use case (correlate one user action's RUM events to its server-side
// trace) we only need:
//   1. Generate a fresh traceparent (32 hex traceId + 16 hex spanId)
//   2. Inject it on outgoing fetches via tracedFetch()
//   3. Stamp the current traceId on every rum.event() so dashboard
//      drilldowns from a slow user → Tempo waterfall just work
//
// No spans are exported from the browser — the server's auto-
// instrumentation creates the actual spans, parented on our traceId.
// That's enough to make Tempo show the full chain.

type TraceCtx = {
  traceId: string;
  spanId: string;
};

let current: TraceCtx | null = null;

function bytesToHex(n: number): string {
  if (typeof crypto === "undefined" || !crypto.getRandomValues) {
    // Fallback: Math.random is non-crypto but fine for trace IDs.
    let s = "";
    for (let i = 0; i < n * 2; i++) {
      s += Math.floor(Math.random() * 16).toString(16);
    }
    return s;
  }
  const arr = new Uint8Array(n);
  crypto.getRandomValues(arr);
  return Array.from(arr)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export function newTraceContext(): TraceCtx {
  current = {
    traceId: bytesToHex(16),
    spanId: bytesToHex(8),
  };
  return current;
}

export function getCurrentTraceContext(): TraceCtx | null {
  return current;
}

export function clearTraceContext(): void {
  current = null;
}

function formatTraceparent(traceId: string, spanId: string): string {
  // version 00, sampled flag 01 (always sample — backend sampler will
  // honour the inherited decision via parent-based ratio at 5%).
  return `00-${traceId}-${spanId}-01`;
}

/**
 * Wraps fetch to inject a W3C traceparent header. Each fetch gets its
 * own spanId under the active traceId so concurrent fetches don't
 * collide on the trace tree. Same-origin only — we don't leak our
 * trace IDs to third-party hosts.
 */
export async function tracedFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const ctx = current ?? newTraceContext();
  const childSpanId = bytesToHex(8);
  const headers = new Headers(init?.headers);
  // Only set traceparent if this is a same-origin request. For cross-
  // origin we skip — propagating our trace ID externally is a small
  // privacy leak and the third party won't honor it anyway.
  const url =
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.toString()
        : input.url;
  const isSameOrigin =
    url.startsWith("/") ||
    (typeof window !== "undefined" && url.startsWith(window.location.origin));
  if (isSameOrigin) {
    headers.set("traceparent", formatTraceparent(ctx.traceId, childSpanId));
  }
  return fetch(input, { ...init, headers });
}
