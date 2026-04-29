import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  // prom-client uses Node built-ins (cluster, v8, fs, net, dns, perf_hooks).
  // Without this, webpack tries to bundle it for the Edge runtime — which
  // can't resolve those built-ins — when instrumentation.ts traces it
  // through tts-backend-selector. Marking it external defers resolution
  // to runtime require(), where the Node check in instrumentation.ts has
  // already returned for Edge.
  serverExternalPackages: ["prom-client"],
};

export default nextConfig;
