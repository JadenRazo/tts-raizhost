// BackendSelector — circuit-breaker-style picker between the primary
// TTS backend (home-GPU over Tailscale) and the fallback (in-cluster
// CPU pod).
//
// Behavior:
//   - Process-wide singleton via globalThis. Survives Next.js hot
//     reloads in dev.
//   - A 60s probe loop hits the *primary*: GET /healthz (must 200 in
//     2s) AND POST /tts (must yield first body byte in 5s).
//   - 3 consecutive probe failures while active=='gpu' flip to 'cpu'.
//   - First successful probe flips back to 'gpu'.
//   - Per-request fallback: a single fetch failure on the active
//     backend bumps consecutiveFails by 1 and serves the request via
//     the fallback URL — does NOT preemptively flip state. The probe
//     loop is the source of truth.
//   - Single-replica assumption: the selector state is process-local.
//     If tts-web ever scales past replicas:1, replicas will disagree
//     and metrics will mix labels — see PLAN.md §15.J.
//
// The probe loop is started from instrumentation.ts (Next.js calls the
// `instrumentation` export once per server lifecycle).

import { env } from "@/lib/env";
import {
  ttsBackendActive,
  ttsBackendHealthProbeDurationSeconds,
  ttsBackendHealthProbeTotal,
  ttsBackendLastProbeAtSeconds,
} from "@/lib/metrics";

export type Backend = "gpu" | "cpu";

type SelectorState = {
  active: Backend;
  consecutiveFails: number;
  lastSuccessAtMs: number;
  lastFailureAtMs: number;
  lastProbeAtMs: number;
  probeTimer: NodeJS.Timeout | null;
};

declare global {
  // eslint-disable-next-line no-var
  var __ttsBackendSelectorState: SelectorState | undefined;
}

const FAIL_THRESHOLD = 3;
const PROBE_INTERVAL_MS = 60_000;
const HEALTHZ_TIMEOUT_MS = 2_000;
const SYNTH_HEALTH_TIMEOUT_MS = 5_000;
const HEALTH_VOICE = "af_heart";
const HEALTH_TEXT = "warmup test";

function initState(): SelectorState {
  return {
    // Optimistic start: assume primary is up. The first probe will
    // correct this within PROBE_INTERVAL_MS even if it's wrong.
    active: "gpu",
    consecutiveFails: 0,
    lastSuccessAtMs: 0,
    lastFailureAtMs: 0,
    lastProbeAtMs: 0,
    probeTimer: null,
  };
}

const state: SelectorState =
  globalThis.__ttsBackendSelectorState ??
  (globalThis.__ttsBackendSelectorState = initState());

function setActiveGauge(active: Backend): void {
  ttsBackendActive.labels({ backend: "gpu" }).set(active === "gpu" ? 1 : 0);
  ttsBackendActive.labels({ backend: "cpu" }).set(active === "cpu" ? 1 : 0);
}
setActiveGauge(state.active);

export function getActiveBackend(): Backend {
  return state.active;
}

export function getActiveUrl(): string {
  return state.active === "gpu" ? env.TTS_PRIMARY_URL : env.TTS_FALLBACK_URL;
}

export function getFallbackUrl(): string {
  return env.TTS_FALLBACK_URL;
}

/** Per-request fallback: the active backend just failed. Bump the fail
 * counter so the next probe iteration can compare against threshold,
 * but do NOT flip state here — the probe loop owns that transition. */
export function recordRequestFailure(): void {
  state.consecutiveFails += 1;
  state.lastFailureAtMs = Date.now();
}

/** A request succeeded against the active backend. Reset the counter
 * but otherwise no state change. */
export function recordRequestSuccess(): void {
  state.consecutiveFails = 0;
  state.lastSuccessAtMs = Date.now();
}

async function probePrimary(): Promise<void> {
  const url = env.TTS_PRIMARY_URL;
  const startedNs = process.hrtime.bigint();
  let outcome: "ok" | "fail" = "fail";

  try {
    // 1. /healthz — fast 200 check.
    const h = await fetch(`${url}/healthz`, {
      signal: AbortSignal.timeout(HEALTHZ_TIMEOUT_MS),
    });
    if (!h.ok) throw new Error(`healthz ${h.status}`);

    // 2. /tts — must produce first byte under SYNTH_HEALTH_TIMEOUT_MS.
    //    Detects "uvicorn up but model wedged" failures that /healthz
    //    can't see.
    const r = await fetch(`${url}/tts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        text: HEALTH_TEXT,
        voice: HEALTH_VOICE,
        speed: 1.0,
      }),
      signal: AbortSignal.timeout(SYNTH_HEALTH_TIMEOUT_MS),
    });
    if (!r.ok || !r.body) throw new Error(`synth ${r.status}`);
    const reader = r.body.getReader();
    const first = await reader.read();
    if (first.done) throw new Error("empty body");
    reader.cancel().catch(() => {});

    outcome = "ok";
    state.consecutiveFails = 0;
    state.lastSuccessAtMs = Date.now();
    if (state.active !== "gpu") {
      console.info("[tts] backend selector flipping cpu -> gpu");
      state.active = "gpu";
      setActiveGauge(state.active);
    }
  } catch (e) {
    state.consecutiveFails += 1;
    state.lastFailureAtMs = Date.now();
    if (
      state.consecutiveFails >= FAIL_THRESHOLD &&
      state.active === "gpu"
    ) {
      console.warn("[tts] backend selector flipping gpu -> cpu", {
        fails: state.consecutiveFails,
        reason: e instanceof Error ? e.message : String(e),
      });
      state.active = "cpu";
      setActiveGauge(state.active);
    }
  } finally {
    state.lastProbeAtMs = Date.now();
    const elapsed =
      Number(process.hrtime.bigint() - startedNs) / 1e9;
    ttsBackendHealthProbeTotal.labels({ backend: "gpu", outcome }).inc();
    ttsBackendHealthProbeDurationSeconds
      .labels({ backend: "gpu" })
      .observe(elapsed);
    ttsBackendLastProbeAtSeconds
      .labels({ backend: "gpu" })
      .set(Math.floor(state.lastProbeAtMs / 1000));
  }
}

/** Start the probe loop. Idempotent — re-calling does nothing. Called
 * once from apps/web/src/instrumentation.ts on server cold start. */
export function startProbeLoop(): void {
  if (state.probeTimer) return;
  // Fire once immediately so we don't sit on the optimistic default
  // for 60s if primary is actually down at boot.
  probePrimary().catch((e) =>
    console.error("[tts] initial probe failed", e),
  );
  state.probeTimer = setInterval(() => {
    probePrimary().catch((e) =>
      console.error("[tts] probe iteration failed", e),
    );
  }, PROBE_INTERVAL_MS);
  // Don't keep the Node process alive just for the probe loop in
  // serverless-style invocations.
  state.probeTimer.unref?.();
}

/** Test-only — stop the probe loop. Production code never calls this. */
export function stopProbeLoop(): void {
  if (state.probeTimer) {
    clearInterval(state.probeTimer);
    state.probeTimer = null;
  }
}
