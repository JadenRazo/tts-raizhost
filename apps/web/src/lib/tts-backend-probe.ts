export type PrimaryProbeResult =
  | { ok: true }
  | { ok: false; reason: string };

export type ProbeTimeouts = {
  healthMs: number;
  synthMs: number;
};

const DEFAULT_TIMEOUTS: ProbeTimeouts = {
  healthMs: 2_000,
  synthMs: 5_000,
};

const HEALTH_VOICE = "af_heart";
const HEALTH_TEXT = "warmup test";

/** Check both HTTP readiness and first-byte synthesis on the primary backend. */
export async function probePrimaryBackend(
  baseUrl: string,
  fetcher: typeof fetch = fetch,
  timeouts: ProbeTimeouts = DEFAULT_TIMEOUTS,
): Promise<PrimaryProbeResult> {
  try {
    const health = await fetcher(`${baseUrl}/healthz`, {
      signal: AbortSignal.timeout(timeouts.healthMs),
    });
    if (!health.ok) return { ok: false, reason: `healthz ${health.status}` };

    const synth = await fetcher(`${baseUrl}/tts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        text: HEALTH_TEXT,
        voice: HEALTH_VOICE,
        speed: 1.0,
      }),
      signal: AbortSignal.timeout(timeouts.synthMs),
    });
    if (!synth.ok) return { ok: false, reason: `synth ${synth.status}` };
    if (!synth.body) return { ok: false, reason: "synth missing body" };

    const reader = synth.body.getReader();
    const first = await reader.read();
    await reader.cancel().catch(() => undefined);
    if (first.done || !first.value?.byteLength) {
      return { ok: false, reason: "synth empty body" };
    }

    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}
