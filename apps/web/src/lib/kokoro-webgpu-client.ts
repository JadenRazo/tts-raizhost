"use client";

// Main-thread wrapper around the kokoro Web Worker. Owns the worker
// lifecycle, normalises progress events, and produces a 24 kHz mono
// WAV blob per synth — same shape the <audio> element already
// consumes from the server path, so the reader's audio code doesn't
// need to know which backend produced the bytes.
//
// One worker per backend, lazily created. Both `webgpu` and `wasm`
// can coexist in theory but in practice only one is used per session
// (the picker decides at mount).

import type { WorkerIn, WorkerOut } from "@/lib/kokoro-worker";

export type LoadProgress = {
  stage: "downloading" | "ready";
  loaded: number;
  total: number;
  file?: string;
};

export type ClientState = "idle" | "loading" | "ready" | "error";

type Backend = "webgpu" | "wasm";

export interface KokoroClient {
  readonly state: ClientState;
  init(): Promise<void>;
  onProgress(cb: (p: LoadProgress) => void): () => void;
  synth(text: string, voice: string, speed: number): Promise<Blob>;
  dispose(): void;
}

type PendingSynth = {
  resolve: (blob: Blob) => void;
  reject: (err: Error) => void;
};

const clients = new Map<Backend, KokoroClient>();

class KokoroClientImpl implements KokoroClient {
  state: ClientState = "idle";

  private worker: Worker | null = null;
  private initPromise: Promise<void> | null = null;
  private progressCbs = new Set<(p: LoadProgress) => void>();
  private pending = new Map<string, PendingSynth>();
  private synthCounter = 0;

  constructor(private readonly backend: Backend) {}

  init(): Promise<void> {
    if (this.initPromise) return this.initPromise;

    this.state = "loading";
    this.initPromise = new Promise<void>((resolve, reject) => {
      let worker: Worker;
      try {
        worker = new Worker(
          new URL("./kokoro-worker.ts", import.meta.url),
          { type: "module" },
        );
      } catch (err) {
        this.state = "error";
        reject(err instanceof Error ? err : new Error(String(err)));
        return;
      }
      this.worker = worker;

      worker.addEventListener("message", (ev: MessageEvent<WorkerOut>) => {
        const msg = ev.data;
        if (!msg || typeof msg !== "object") return;
        switch (msg.type) {
          case "init-progress":
            this.emitProgress({
              stage: "downloading",
              loaded: msg.loaded,
              total: msg.total,
              file: msg.file,
            });
            return;
          case "init-ready":
            this.state = "ready";
            this.emitProgress({ stage: "ready", loaded: 1, total: 1 });
            resolve();
            return;
          case "init-error":
            this.state = "error";
            reject(new Error(msg.error));
            return;
          case "synth-result": {
            const pending = this.pending.get(msg.id);
            if (!pending) return;
            this.pending.delete(msg.id);
            try {
              const blob = encodeWav(msg.samples, msg.sampleRate);
              pending.resolve(blob);
            } catch (err) {
              pending.reject(err instanceof Error ? err : new Error(String(err)));
            }
            return;
          }
          case "synth-error": {
            const pending = this.pending.get(msg.id);
            if (!pending) return;
            this.pending.delete(msg.id);
            pending.reject(new Error(msg.error));
            return;
          }
        }
      });

      worker.addEventListener("error", (ev) => {
        const err = new Error(ev.message || "kokoro worker error");
        if (this.state === "loading") {
          this.state = "error";
          reject(err);
        }
        // Drain in-flight synths with the same error.
        for (const [id, p] of this.pending) {
          p.reject(err);
          this.pending.delete(id);
        }
      });

      const initMsg: WorkerIn = { type: "init", backend: this.backend };
      worker.postMessage(initMsg);
    });

    return this.initPromise;
  }

  onProgress(cb: (p: LoadProgress) => void): () => void {
    this.progressCbs.add(cb);
    return () => {
      this.progressCbs.delete(cb);
    };
  }

  async synth(text: string, voice: string, speed: number): Promise<Blob> {
    await this.init();
    const worker = this.worker;
    if (!worker) throw new Error("kokoro worker not running");

    const id = `s${++this.synthCounter}`;
    return new Promise<Blob>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      const msg: WorkerIn = { type: "synth", id, text, voice, speed };
      worker.postMessage(msg);
    });
  }

  dispose(): void {
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
    this.initPromise = null;
    this.state = "idle";
    this.progressCbs.clear();
    for (const [id, p] of this.pending) {
      p.reject(new Error("kokoro client disposed"));
      this.pending.delete(id);
    }
  }

  private emitProgress(p: LoadProgress): void {
    for (const cb of this.progressCbs) {
      try {
        cb(p);
      } catch (err) {
        // A bad listener shouldn't poison the rest.
        console.error("[kokoro] progress listener threw", err);
      }
    }
  }
}

export function getClient(backend: Backend): KokoroClient {
  let client = clients.get(backend);
  if (!client) {
    client = new KokoroClientImpl(backend);
    clients.set(backend, client);
  }
  return client;
}

// ---------------------------------------------------------------------------
// WAV encoding. 24 kHz mono Int16 PCM. The kokoro-js RawAudio.toWav()
// helper does the same thing but lives inside the worker — encoding
// in the main thread keeps the worker→main message payload minimal
// (Float32 + sampleRate, transferable) and lets us own the byte
// format here without a transformers.js dep on the main thread.
// ---------------------------------------------------------------------------

const WAV_HEADER_BYTES = 44;

function encodeWav(samples: Float32Array, sampleRate: number): Blob {
  const numSamples = samples.length;
  const dataBytes = numSamples * 2; // Int16
  const buffer = new ArrayBuffer(WAV_HEADER_BYTES + dataBytes);
  const view = new DataView(buffer);

  // RIFF header
  writeAscii(view, 0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  writeAscii(view, 8, "WAVE");

  // fmt chunk
  writeAscii(view, 12, "fmt ");
  view.setUint32(16, 16, true); // PCM chunk size
  view.setUint16(20, 1, true);  // format = 1 (PCM)
  view.setUint16(22, 1, true);  // channels = 1 (mono)
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate (mono * 2 bytes)
  view.setUint16(32, 2, true);  // block align (mono * 2 bytes)
  view.setUint16(34, 16, true); // bits per sample

  // data chunk
  writeAscii(view, 36, "data");
  view.setUint32(40, dataBytes, true);

  // Float32 [-1, 1] → Int16. Clamp to avoid wrap on out-of-range
  // samples; kokoro normally stays well within bounds but a clipping
  // boundary case shouldn't produce a screech.
  let offset = WAV_HEADER_BYTES;
  for (let i = 0; i < numSamples; i++) {
    let s = samples[i];
    if (s > 1) s = 1;
    else if (s < -1) s = -1;
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    offset += 2;
  }

  return new Blob([buffer], { type: "audio/wav" });
}

function writeAscii(view: DataView, offset: number, value: string): void {
  for (let i = 0; i < value.length; i++) {
    view.setUint8(offset + i, value.charCodeAt(i));
  }
}
