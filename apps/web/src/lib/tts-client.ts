// HTTP client for the Kokoro service.
//
// Contract (identical for both backends — services/kokoro/ on CPU and
// services/kokoro-gpu/ on the home GPU):
//   POST /tts        { text, voice, speed } -> audio/ogg (Opus)
//   GET  /healthz    -> { ok, model_loaded, voices_loaded }
//   GET  /voices     -> { voices: [{ id, language, gender }] }
//
// Each call accepts an optional `baseUrl` so the /api/tts route handler
// can target the active backend (chosen by tts-backend-selector) and
// retry against the fallback URL on failure. If `baseUrl` is omitted,
// the legacy KOKORO_URL/TTS_FALLBACK_URL is used so other call sites
// (e.g. the voices picker, prerender) get sensible defaults without
// touching the selector.
//
// 30s timeout via AbortController — warm-path is well under a second
// per sentence, so anything past 30s means the model loader is stuck.

import { env } from "@/lib/env";

const SYNTH_TIMEOUT_MS = 30_000;
const VOICES_TIMEOUT_MS = 5_000;

export class KokoroUnreachableError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "KokoroUnreachableError";
  }
}

export class KokoroError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "KokoroError";
    this.status = status;
  }
}

export type Voice = {
  id: string;
  language: string;
  gender: string;
};

export async function synthesize(
  text: string,
  voice: string,
  speed: number,
  options?: { baseUrl?: string },
): Promise<Buffer> {
  const baseUrl = options?.baseUrl ?? env.TTS_FALLBACK_URL;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SYNTH_TIMEOUT_MS);
  try {
    const res = await fetch(`${baseUrl}/tts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text, voice, speed }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new KokoroError(
        res.status,
        `Kokoro /tts ${res.status}${detail ? `: ${detail.slice(0, 200)}` : ""}`,
      );
    }
    const ab = await res.arrayBuffer();
    return Buffer.from(ab);
  } catch (err) {
    if (err instanceof KokoroError) throw err;
    throw new KokoroUnreachableError(
      err instanceof Error ? err.message : "Kokoro request failed",
      { cause: err },
    );
  } finally {
    clearTimeout(timer);
  }
}

export async function synthesizeStream(
  text: string,
  voice: string,
  speed: number,
  upstreamSignal?: AbortSignal,
  options?: { baseUrl?: string },
): Promise<ReadableStream<Uint8Array>> {
  // Long timeout — the request stays open while bytes stream, so the
  // total deadline applies to the *full sentence* synthesis. The first
  // bytes arrive much sooner. We also chain `upstreamSignal` from the
  // /api/tts handler so when the client aborts (e.g. user clicked Next
  // and the old prefetch was canceled), the kokoro request aborts too
  // — kokoro stops synthesizing and the pod's CPU is freed for the
  // next request.
  const baseUrl = options?.baseUrl ?? env.TTS_FALLBACK_URL;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SYNTH_TIMEOUT_MS);
  const onUpstreamAbort = () => controller.abort();
  if (upstreamSignal) {
    if (upstreamSignal.aborted) controller.abort();
    else upstreamSignal.addEventListener("abort", onUpstreamAbort, { once: true });
  }
  try {
    const res = await fetch(`${baseUrl}/tts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text, voice, speed }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new KokoroError(
        res.status,
        `Kokoro /tts ${res.status}${detail ? `: ${detail.slice(0, 200)}` : ""}`,
      );
    }
    if (!res.body) {
      throw new KokoroError(res.status, "Kokoro /tts returned no body");
    }
    // Chain abort cleanup to the stream lifetime — the timeout above was
    // a fallback, but in practice the stream consumer drives completion.
    const body = res.body;
    body.getReader; // ensure ReadableStream typing
    return body.pipeThrough(
      new TransformStream({
        flush() {
          clearTimeout(timer);
          if (upstreamSignal) {
            upstreamSignal.removeEventListener("abort", onUpstreamAbort);
          }
        },
      }),
    );
  } catch (err) {
    clearTimeout(timer);
    if (upstreamSignal) {
      upstreamSignal.removeEventListener("abort", onUpstreamAbort);
    }
    if (err instanceof KokoroError) throw err;
    throw new KokoroUnreachableError(
      err instanceof Error ? err.message : "Kokoro request failed",
      { cause: err },
    );
  }
}

export async function fetchVoices(options?: { baseUrl?: string }): Promise<Voice[]> {
  const baseUrl = options?.baseUrl ?? env.TTS_FALLBACK_URL;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), VOICES_TIMEOUT_MS);
  try {
    const res = await fetch(`${baseUrl}/voices`, {
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new KokoroError(res.status, `Kokoro /voices ${res.status}`);
    }
    const body = (await res.json()) as { voices?: Voice[] };
    return Array.isArray(body.voices) ? body.voices : [];
  } catch (err) {
    if (err instanceof KokoroError) throw err;
    throw new KokoroUnreachableError(
      err instanceof Error ? err.message : "Kokoro voices request failed",
      { cause: err },
    );
  } finally {
    clearTimeout(timer);
  }
}
