// Prometheus metrics surface for the web app. One singleton Registry
// fed by every route handler that opts in via `withMetrics` or by
// updating the named collectors directly.
//
// Phase 1: registry + default Node.js metrics + http_request_duration.
// Phase 2: custom TTS-path metrics (tts_request_duration, kokoro upstream,
// cache hit/miss, sentences-page, position-save, prerender).
// Phase 3: rum_* collectors fed from /api/rum.
//
// Cardinality discipline: never label by user_id, book_id, or raw text.
// `voice` (≤8) and `text_len_bucket` (5) are the only fan-outs allowed.

import { collectDefaultMetrics, Counter, Gauge, Histogram, Registry } from "prom-client";

declare global {
  // eslint-disable-next-line no-var
  var __ttsMetricsRegistry: Registry | undefined;
}

function buildRegistry(): Registry {
  const r = new Registry();
  r.setDefaultLabels({ app: "tts-web" });
  collectDefaultMetrics({ register: r, prefix: "ttsweb_node_" });
  return r;
}

// Singleton across hot-reloads (Next dev) and within a single Node process.
export const registry: Registry = globalThis.__ttsMetricsRegistry ?? buildRegistry();
if (!globalThis.__ttsMetricsRegistry) {
  globalThis.__ttsMetricsRegistry = registry;
}

// ---------------------------------------------------------------------
// Generic HTTP RED metrics. Buckets favor sub-second routes; the TTS
// route gets its own histogram in Phase 2 with an extended tail.
// ---------------------------------------------------------------------

export const httpRequestDurationSeconds = getOrCreateHistogram({
  name: "http_request_duration_seconds",
  help: "Duration of HTTP requests handled by the web app, by route.",
  labelNames: ["route", "method", "status"],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10],
});

// ---------------------------------------------------------------------
// TTS path histograms (wired in Phase 2, but registered here so the
// /api/metrics surface is stable from Phase 1 onward).
// ---------------------------------------------------------------------

export const ttsRequestDurationSeconds = getOrCreateHistogram({
  name: "tts_request_duration_seconds",
  help: "Duration of /api/tts requests by cache outcome and voice.",
  labelNames: ["cache", "voice", "status"],
  buckets: [0.002, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10],
});

export const ttsKokoroUpstreamDurationSeconds = getOrCreateHistogram({
  name: "tts_kokoro_upstream_duration_seconds",
  help: "Time spent waiting for kokoro on the cache-miss path (start of fetch to first byte).",
  labelNames: ["voice", "outcome"],
  buckets: [0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10],
});

// ---------------------------------------------------------------------
// Backend routing metrics. The web app picks between primary (home-GPU)
// and fallback (in-cluster CPU) per request; these counters expose the
// split + the breaker's probe outcomes.
// ---------------------------------------------------------------------

export const ttsBackendRouteTotal = getOrCreateCounter({
  name: "tts_backend_route_total",
  help: "TTS requests by backend served and outcome.",
  // backend: gpu | cpu | cache
  // outcome: ok | fallback | fail
  labelNames: ["backend", "outcome"],
});

export const ttsBackendHealthProbeTotal = getOrCreateCounter({
  name: "tts_backend_health_probe_total",
  help: "Health probe outcomes against the primary TTS backend.",
  labelNames: ["backend", "outcome"],
});

export const ttsBackendHealthProbeDurationSeconds = getOrCreateHistogram({
  name: "tts_backend_health_probe_duration_seconds",
  help: "Wall time for one health-probe iteration (healthz + 1-sentence synth).",
  labelNames: ["backend"],
  buckets: [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10],
});

export const ttsBackendActive = getOrCreateGauge({
  name: "tts_backend_active",
  help: "1 if the named backend is currently the active selector target.",
  labelNames: ["backend"],
});

export const ttsBackendLastProbeAtSeconds = getOrCreateGauge({
  name: "tts_backend_last_probe_at_seconds",
  help: "Unix timestamp of the most recent probe iteration. Stale = probe loop dead.",
  labelNames: ["backend"],
});

export const ttsCacheHitsTotal = getOrCreateCounter({
  name: "tts_cache_hits_total",
  help: "Number of /api/tts cache hits.",
  labelNames: ["voice"],
});

export const ttsCacheMissesTotal = getOrCreateCounter({
  name: "tts_cache_misses_total",
  help: "Number of /api/tts cache misses.",
  labelNames: ["voice"],
});

export const ttsCacheBytesTotal = getOrCreateCounter({
  name: "tts_cache_bytes_total",
  help: "Bytes served from the audio cache.",
  labelNames: ["cache_status"],
});

export const sentencesPageDurationSeconds = getOrCreateHistogram({
  name: "sentences_page_duration_seconds",
  help: "Duration of /api/books/:id/sentences-page requests.",
  labelNames: ["status"],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1],
});

export const positionSaveDurationSeconds = getOrCreateHistogram({
  name: "position_save_duration_seconds",
  help: "Duration of /api/books/:id/position PUT requests.",
  labelNames: ["status"],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1],
});

export const prerenderJobsTotal = getOrCreateCounter({
  name: "prerender_jobs_total",
  help: "Prerender job outcomes.",
  labelNames: ["outcome"],
});

export const prerenderInflight = getOrCreateGauge({
  name: "prerender_inflight",
  help: "Prerender jobs currently in flight.",
});

// ---------------------------------------------------------------------
// RUM histograms (fed from /api/rum in Phase 3).
// ---------------------------------------------------------------------

export const rumPlayToAudibleSeconds = getOrCreateHistogram({
  name: "rum_play_to_audible_seconds",
  help: "Time from user clicking Play to first audible audio sample.",
  buckets: [0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 30],
});

export const rumCanPlayToAudibleSeconds = getOrCreateHistogram({
  name: "rum_can_play_to_audible_seconds",
  help: "Time from canplay event to playing event.",
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2],
});

export const rumAudioStallsTotal = getOrCreateCounter({
  name: "rum_audio_stalls_total",
  help: "Audio stall events observed in the reader.",
});

export const rumAudioStallDurationSeconds = getOrCreateHistogram({
  name: "rum_audio_stall_duration_seconds",
  help: "Duration of audio stalls until recovery.",
  buckets: [0.5, 1, 2, 4, 8, 15],
});

export const rumAudioErrorsTotal = getOrCreateCounter({
  name: "rum_audio_errors_total",
  help: "Audio errors observed in the reader by kind.",
  labelNames: ["kind"],
});

export const rumPrefetchFiredTotal = getOrCreateCounter({
  name: "rum_prefetch_fired_total",
  help: "Prefetch attempts by outcome.",
  labelNames: ["outcome"],
});

export const rumSentencePageLoadSeconds = getOrCreateHistogram({
  name: "rum_sentence_page_load_seconds",
  help: "Client-observed sentence-page load duration.",
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1],
});

export const rumPositionSaveFailedTotal = getOrCreateCounter({
  name: "rum_position_save_failed_total",
  help: "Position-save failures observed by the reader.",
});

export const rumWebVital = getOrCreateHistogram({
  name: "rum_web_vital",
  help: "Web Vitals values observed across all routes.",
  // route label is template-bucketed (8 known + 'other') in /api/rum, so
  // cardinality is metric (5) × route (~9) = ~45 series — well-bounded.
  labelNames: ["metric", "route"],
  buckets: [0.1, 0.25, 0.5, 1, 2, 4, 8],
});

export const rumJsErrorsTotal = getOrCreateCounter({
  name: "rum_js_errors_total",
  help: "JavaScript errors captured on the client by class and route.",
  // error_class bounded to 9 (allowlist + Other), route bounded to ~9.
  labelNames: ["error_class", "route"],
});

export const rumFunnelStepTotal = getOrCreateCounter({
  name: "rum_funnel_step_total",
  help: "Funnel step events (upload_succeeded, read_started, read_engaged_30s, read_session_end).",
  labelNames: ["step"],
});

// ---------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------

type HistogramOpts = {
  name: string;
  help: string;
  labelNames?: string[];
  buckets: number[];
};

type CounterOpts = {
  name: string;
  help: string;
  labelNames?: string[];
};

type GaugeOpts = {
  name: string;
  help: string;
  labelNames?: string[];
};

function getOrCreateHistogram(opts: HistogramOpts): Histogram<string> {
  const existing = registry.getSingleMetric(opts.name);
  if (existing) return existing as Histogram<string>;
  return new Histogram({
    name: opts.name,
    help: opts.help,
    labelNames: opts.labelNames ?? [],
    buckets: opts.buckets,
    registers: [registry],
  });
}

function getOrCreateCounter(opts: CounterOpts): Counter<string> {
  const existing = registry.getSingleMetric(opts.name);
  if (existing) return existing as Counter<string>;
  return new Counter({
    name: opts.name,
    help: opts.help,
    labelNames: opts.labelNames ?? [],
    registers: [registry],
  });
}

function getOrCreateGauge(opts: GaugeOpts): Gauge<string> {
  const existing = registry.getSingleMetric(opts.name);
  if (existing) return existing as Gauge<string>;
  return new Gauge({
    name: opts.name,
    help: opts.help,
    labelNames: opts.labelNames ?? [],
    registers: [registry],
  });
}

// ---------------------------------------------------------------------
// withMetrics — a thin wrapper for App Router route handlers. Times the
// response and emits an http_request_duration_seconds observation. For
// streaming responses, observation fires when the stream is closed
// (consumed or aborted) — not when the handler returns the Response,
// since that happens before bytes are sent.
// ---------------------------------------------------------------------

export type RouteHandler<Ctx = unknown> = (
  request: Request,
  context: Ctx,
) => Promise<Response> | Response;

export function withMetrics<Ctx = unknown>(
  handler: RouteHandler<Ctx>,
  routeName: string,
): RouteHandler<Ctx> {
  return async (request, context) => {
    const start = process.hrtime.bigint();
    let status = 0;
    try {
      const res = await handler(request, context);
      status = res.status;
      // For streaming bodies, observe when the stream completes. We replace
      // the body with one that signals on close.
      if (res.body) {
        const body = res.body;
        const observed = body.pipeThrough(
          new TransformStream<Uint8Array, Uint8Array>({
            flush: () => {
              recordHttp(routeName, request.method, status, start);
            },
          }),
        );
        return new Response(observed, {
          status: res.status,
          statusText: res.statusText,
          headers: res.headers,
        });
      }
      recordHttp(routeName, request.method, status, start);
      return res;
    } catch (err) {
      recordHttp(routeName, request.method, status || 500, start);
      throw err;
    }
  };
}

function recordHttp(route: string, method: string, status: number, startNs: bigint): void {
  const elapsed = Number(process.hrtime.bigint() - startNs) / 1e9;
  httpRequestDurationSeconds
    .labels({ route, method, status: String(status) })
    .observe(elapsed);
}

// ---------------------------------------------------------------------
// Time helper used by per-route custom histograms (e.g. tts_request_duration)
// that don't go through `withMetrics` because they need extra labels.
// ---------------------------------------------------------------------

export function startTimer(): () => number {
  const start = process.hrtime.bigint();
  return () => Number(process.hrtime.bigint() - start) / 1e9;
}
