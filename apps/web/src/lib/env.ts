// Typed env access. Throws at use-time if a required var is missing,
// not at module-load time, so `next build` can run without secrets.

function required(name: string): string {
  const v = process.env[name];
  if (!v) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return v;
}

function optional(name: string, fallback?: string): string | undefined {
  return process.env[name] ?? fallback;
}

export const env = {
  get DATABASE_URL() {
    return required("DATABASE_URL");
  },
  get BETTER_AUTH_SECRET() {
    return required("BETTER_AUTH_SECRET");
  },
  get BETTER_AUTH_URL() {
    return optional("BETTER_AUTH_URL", "http://localhost:3000")!;
  },
  get BETTER_AUTH_TRUSTED_ORIGINS() {
    const v = optional("BETTER_AUTH_TRUSTED_ORIGINS", "");
    return v ? v.split(",").map((s) => s.trim()).filter(Boolean) : [];
  },
  get AUTH_KMS_KEY() {
    const v = required("AUTH_KMS_KEY");
    if (v.length !== 64 || !/^[0-9a-f]+$/i.test(v)) {
      throw new Error("AUTH_KMS_KEY must be 64 hex chars (32 bytes)");
    }
    return v;
  },
  get PUBLIC_BASE_URL() {
    return optional("PUBLIC_BASE_URL", "http://localhost:3000")!;
  },
  // Primary TTS backend — preferred until the circuit breaker opens.
  // In prod this points at the home-GPU service over Tailscale
  // (e.g. http://desktop-7hf36jh:8000). Falls back to TTS_FALLBACK_URL,
  // then to the legacy KOKORO_URL, then to localhost for dev.
  get TTS_PRIMARY_URL() {
    return optional("TTS_PRIMARY_URL")
      ?? optional("KOKORO_URL")
      ?? "http://localhost:8101";
  },
  // Fallback TTS backend — the in-cluster CPU service. Always reachable
  // from the web pod via the ClusterIP service.
  get TTS_FALLBACK_URL() {
    return optional("TTS_FALLBACK_URL")
      ?? optional("KOKORO_URL")
      ?? "http://localhost:8101";
  },
  /** @deprecated use TTS_PRIMARY_URL or TTS_FALLBACK_URL. Kept for back-compat. */
  get KOKORO_URL() {
    return this.TTS_FALLBACK_URL;
  },
  get DATA_DIR() {
    return optional("DATA_DIR", "/data")!;
  },
  get BOOKS_DIR() {
    return optional("BOOKS_DIR", `${this.DATA_DIR}/books`)!;
  },
  get CACHE_DIR() {
    return optional("CACHE_DIR", `${this.DATA_DIR}/cache`)!;
  },
  get NODE_ENV() {
    return optional("NODE_ENV", "development")!;
  },
  get IS_PRODUCTION() {
    return this.NODE_ENV === "production";
  },
};
