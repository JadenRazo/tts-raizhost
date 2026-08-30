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
//   - Per-request fallback serves from the fallback URL but does not alter
//     probe-owned circuit state. The probe loop is the source of truth.
//   - Single-replica assumption: the selector state is process-local.
//     If tts-web ever scales past replicas:1, replicas will disagree
//     and metrics will mix labels — see docs/architecture.md.
//
// The probe loop is started from instrumentation.ts (Next.js calls the
// `instrumentation` export once per server lifecycle).

import { env } from "@/lib/env";
import { probePrimaryBackend } from "@/lib/tts-backend-probe";
import {
  afterPrimaryProbe,
  afterRequest,
  type Backend,
  type BackendCircuitState,
} from "@/lib/tts-backend-state";
import {
  ttsBackendActive,
  ttsBackendHealthProbeDurationSeconds,
  ttsBackendHealthProbeTotal,
  ttsBackendLastProbeAtSeconds,
} from "@/lib/metrics";

export type { Backend } from "@/lib/tts-backend-state";

type SelectorState = {
  active: Backend;
  consecutiveProbeFails: number;
  lastSuccessAtMs: number;
  lastFailureAtMs: number;
  lastProbeAtMs: number;
  probeTimer: NodeJS.Timeout | null;
};

declare global {
  // eslint-disable-next-line no-var
  var __ttsBackendSelectorState: SelectorState | undefined;
}

const PROBE_INTERVAL_MS = 60_000;

function initState(): SelectorState {
  return {
    // Optimistic start: assume primary is up. The first probe will
    // correct this within PROBE_INTERVAL_MS even if it's wrong.
    active: "gpu",
    consecutiveProbeFails: 0,
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

/** Record timing for a failed request without changing probe-owned state. */
export function recordRequestFailure(): void {
  applyCircuitState(afterRequest(state));
  state.lastFailureAtMs = Date.now();
}

/** Record timing for a successful request without changing probe-owned state. */
export function recordRequestSuccess(): void {
  applyCircuitState(afterRequest(state));
  state.lastSuccessAtMs = Date.now();
}

function applyCircuitState(next: BackendCircuitState): void {
  const changed = next.active !== state.active;
  state.active = next.active;
  state.consecutiveProbeFails = next.consecutiveProbeFails;
  if (changed) setActiveGauge(state.active);
}

async function probePrimary(): Promise<void> {
  const url = env.TTS_PRIMARY_URL;
  const startedNs = process.hrtime.bigint();
  let outcome: "ok" | "fail" = "fail";

  try {
    const probe = await probePrimaryBackend(url);
    if (!probe.ok) throw new Error(probe.reason);

    outcome = "ok";
    const previous = state.active;
    applyCircuitState(afterPrimaryProbe(state, true));
    state.lastSuccessAtMs = Date.now();
    if (previous !== state.active) {
      console.info("[tts] backend selector flipping cpu -> gpu");
    }
  } catch (e) {
    const previous = state.active;
    applyCircuitState(afterPrimaryProbe(state, false));
    state.lastFailureAtMs = Date.now();
    if (previous !== state.active) {
      console.warn("[tts] backend selector flipping gpu -> cpu", {
        fails: state.consecutiveProbeFails,
        reason: e instanceof Error ? e.message : String(e),
      });
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
