// Browser-only capability probe: which kokoro-js backend (if any) the
// device can run locally without melting? The decision tree is biased
// toward "be conservative" — a wrong yes-WebGPU verdict produces a
// visibly stuck reader, while a wrong yes-server verdict just costs a
// round-trip. So we require headroom on both memory and GPU buffer
// limits before opting into local inference.
//
// The result is computed at most once per page load (memoized in
// module state) and mirrored into sessionStorage so synchronous
// readers (e.g. status pills, route-time decisions) don't re-run the
// async checks. SSR safety: callers must guard with `typeof window !==
// "undefined"` or invoke from a `"use client"` boundary.

export type KokoroBackend = "webgpu" | "wasm" | "server";

const SESSION_STORAGE_KEY = "kokoro-backend-v1";
const MOBILE_UA_RE = /Android|iPhone|iPad|iPod/i;

// WebGPU adapter limits we require before trusting the device with the
// 82M-param model in fp32. The model's largest buffer is ~330 MB; we
// leave headroom so a tab with other GPU work doesn't OOM the adapter.
const WEBGPU_MIN_MAX_BUFFER_SIZE = 512 * 1024 * 1024;
const WEBGPU_MIN_STORAGE_BINDING_SIZE = 256 * 1024 * 1024;
// WASM fallback is heavier on RAM than on GPU; a 4 GB device chokes
// at q8. 8 GB + 8 cores is the floor where local synth beats the
// network round-trip on cold cache misses.
const WASM_MIN_DEVICE_MEMORY_GB = 8;
const WASM_MIN_CORES = 8;
// Mobile WebGPU is real (M-series iPad, Pixel 8+) but the thermal
// envelope is tight; require a step up from the 4 GB desktop floor.
const MOBILE_WEBGPU_MIN_DEVICE_MEMORY_GB = 6;

type DeviceMemoryNavigator = Navigator & { deviceMemory?: number };

let cached: KokoroBackend | null = null;
let inflight: Promise<KokoroBackend> | null = null;

function readFromSessionStorage(): KokoroBackend | null {
  if (typeof sessionStorage === "undefined") return null;
  try {
    const raw = sessionStorage.getItem(SESSION_STORAGE_KEY);
    if (raw === "webgpu" || raw === "wasm" || raw === "server") return raw;
    return null;
  } catch {
    // Private-mode Safari throws on sessionStorage access; treat as
    // "no cached value, will recompute".
    return null;
  }
}

function writeToSessionStorage(backend: KokoroBackend): void {
  if (typeof sessionStorage === "undefined") return;
  try {
    sessionStorage.setItem(SESSION_STORAGE_KEY, backend);
  } catch {
    // Quota / disabled — best-effort only.
  }
}

export function getCachedBackend(): KokoroBackend | null {
  if (cached !== null) return cached;
  const fromStorage = readFromSessionStorage();
  if (fromStorage !== null) {
    cached = fromStorage;
    return cached;
  }
  return null;
}

async function probeWebGPU(
  deviceMemory: number,
  isMobile: boolean,
): Promise<boolean> {
  const nav = navigator as Navigator & {
    gpu?: {
      requestAdapter: (options?: {
        powerPreference?: "high-performance" | "low-power";
      }) => Promise<{
        limits: { maxBufferSize?: number; maxStorageBufferBindingSize?: number };
      } | null>;
    };
  };
  if (!nav.gpu || typeof nav.gpu.requestAdapter !== "function") return false;

  let adapter: { limits: { maxBufferSize?: number; maxStorageBufferBindingSize?: number } } | null;
  try {
    adapter = await nav.gpu.requestAdapter({ powerPreference: "high-performance" });
  } catch {
    return false;
  }
  if (!adapter) return false;

  const maxBuffer = adapter.limits.maxBufferSize ?? 0;
  const maxStorage = adapter.limits.maxStorageBufferBindingSize ?? 0;
  if (maxBuffer < WEBGPU_MIN_MAX_BUFFER_SIZE) return false;
  if (maxStorage < WEBGPU_MIN_STORAGE_BINDING_SIZE) return false;

  if (isMobile && deviceMemory < MOBILE_WEBGPU_MIN_DEVICE_MEMORY_GB) return false;

  return true;
}

async function compute(): Promise<KokoroBackend> {
  if (typeof navigator === "undefined") return "server";

  const nav = navigator as DeviceMemoryNavigator;
  const deviceMemory = nav.deviceMemory ?? 4;
  const cores = nav.hardwareConcurrency ?? 2;
  const ua = typeof nav.userAgent === "string" ? nav.userAgent : "";
  const isMobile = MOBILE_UA_RE.test(ua);

  if (deviceMemory < 4) return "server";
  if (cores < 4) return "server";

  if ("gpu" in nav) {
    const ok = await probeWebGPU(deviceMemory, isMobile);
    if (ok) return "webgpu";
  }

  if (
    !isMobile &&
    deviceMemory >= WASM_MIN_DEVICE_MEMORY_GB &&
    cores >= WASM_MIN_CORES
  ) {
    return "wasm";
  }

  return "server";
}

export async function pickKokoroBackend(): Promise<KokoroBackend> {
  if (cached !== null) return cached;
  const fromStorage = readFromSessionStorage();
  if (fromStorage !== null) {
    cached = fromStorage;
    return cached;
  }
  if (inflight) return inflight;

  inflight = (async () => {
    let result: KokoroBackend;
    try {
      result = await compute();
    } catch {
      // Any unexpected throw in feature detection → degrade to server.
      // We never want the picker itself to surface an error to the user.
      result = "server";
    }
    cached = result;
    writeToSessionStorage(result);
    inflight = null;
    return result;
  })();

  return inflight;
}
