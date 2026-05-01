// Web Worker that owns the kokoro-js model. Lives off the main thread
// so model load (300+ MB download, ONNX session creation) and per-
// sentence synthesis don't block the reader UI.
//
// Lifecycle:
//   main → worker: { type: "init", backend }
//   worker → main: { type: "init-progress", ... }*  (during download)
//   worker → main: { type: "init-ready" } | { type: "init-error", error }
//   main → worker: { type: "synth", id, text, voice, speed }
//   worker → main: { type: "synth-result", id, samples, sampleRate } |
//                  { type: "synth-error", id, error }
//
// The samples buffer is transferred (not copied) so the main thread
// can encode WAV without a second allocation.
//
// Model variant selection mirrors the kokoro-js README: fp32 on
// WebGPU (full quality, GPU has the headroom), q8 on WASM (quantised
// so the CPU path doesn't take 30s/sentence). dtypes match the
// kokoro-js typings.

/// <reference lib="webworker" />

import type { KokoroTTS } from "kokoro-js";

export type KokoroBackendDevice = "webgpu" | "wasm";

export type WorkerIn =
  | { type: "init"; backend: KokoroBackendDevice }
  | { type: "synth"; id: string; text: string; voice: string; speed: number };

export type WorkerOut =
  | { type: "init-progress"; loaded: number; total: number; file: string }
  | { type: "init-ready" }
  | { type: "init-error"; error: string }
  | { type: "synth-result"; id: string; samples: Float32Array; sampleRate: number }
  | { type: "synth-error"; id: string; error: string };

const MODEL_ID = "onnx-community/Kokoro-82M-v1.0-ONNX";

// Loaded lazily on the first "init" message — costs ~300 MB and
// several seconds, so we don't pay it for users who never need it.
let ttsPromise: Promise<KokoroTTS> | null = null;
let initBackend: KokoroBackendDevice | null = null;

type ProgressInfo =
  | { status: "initiate"; name: string; file: string }
  | { status: "download"; name: string; file: string }
  | { status: "progress"; name: string; file: string; progress: number; loaded: number; total: number }
  | { status: "done"; name: string; file: string }
  | { status: "ready"; task: string; model: string };

function postOut(msg: WorkerOut, transfer?: Transferable[]) {
  if (transfer && transfer.length > 0) {
    (self as unknown as Worker).postMessage(msg, transfer);
  } else {
    (self as unknown as Worker).postMessage(msg);
  }
}

async function loadKokoro(backend: KokoroBackendDevice): Promise<KokoroTTS> {
  // Dynamic import keeps the Worker bundle lean until first use, and
  // — more importantly — makes sure kokoro-js's transformers.js
  // dependency only resolves inside the Worker's scope (it touches
  // browser-only globals like `navigator.gpu`).
  const { KokoroTTS } = await import("kokoro-js");
  return KokoroTTS.from_pretrained(MODEL_ID, {
    dtype: backend === "webgpu" ? "fp32" : "q8",
    device: backend,
    progress_callback: (info: ProgressInfo) => {
      if (info.status === "progress") {
        postOut({
          type: "init-progress",
          loaded: info.loaded,
          total: info.total,
          file: info.file,
        });
      }
    },
  });
}

async function ensureLoaded(backend: KokoroBackendDevice): Promise<KokoroTTS> {
  if (ttsPromise && initBackend === backend) return ttsPromise;
  if (ttsPromise && initBackend !== backend) {
    // Backend swap mid-session is not supported in this build — the
    // first init wins. Surface a clear error rather than silently
    // returning the wrong-device model.
    throw new Error(
      `kokoro worker already initialised for ${initBackend}; cannot switch to ${backend}`,
    );
  }
  initBackend = backend;
  ttsPromise = loadKokoro(backend);
  return ttsPromise;
}

self.addEventListener("message", async (ev: MessageEvent<WorkerIn>) => {
  const msg = ev.data;
  if (!msg || typeof msg !== "object") return;

  if (msg.type === "init") {
    try {
      await ensureLoaded(msg.backend);
      postOut({ type: "init-ready" });
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      // Reset so a future init can retry — a stuck rejected promise
      // would otherwise pin the worker into a permanent error state.
      ttsPromise = null;
      initBackend = null;
      postOut({ type: "init-error", error });
    }
    return;
  }

  if (msg.type === "synth") {
    try {
      if (!ttsPromise || !initBackend) {
        throw new Error("kokoro worker not initialised; send 'init' first");
      }
      const tts = await ttsPromise;
      // kokoro-js types `voice` as a literal union of all 28 IDs. Our
      // ALLOWED_VOICES is the same set unioned at a different layer
      // (route validation), so widen the options object to the call's
      // expected shape via Parameters<> to avoid restating the union.
      type GenerateOpts = NonNullable<Parameters<KokoroTTS["generate"]>[1]>;
      const audio = await tts.generate(msg.text, {
        voice: msg.voice as GenerateOpts["voice"],
        speed: msg.speed,
      });
      // Transfer the underlying buffer to the main thread to avoid a
      // copy. After transfer, `audio.audio` is detached in the worker
      // — that's fine, we don't reuse it.
      const samples = audio.audio;
      postOut(
        {
          type: "synth-result",
          id: msg.id,
          samples,
          sampleRate: audio.sampling_rate,
        },
        [samples.buffer],
      );
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      postOut({ type: "synth-error", id: msg.id, error });
    }
  }
});
