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
  async headers() {
    // Long-lived caching for build-hashed assets. Returning users currently
    // re-validate ~200-400KB of /_next/static/* on every navigation because
    // nothing in this stack sets Cache-Control for them. Files under
    // /_next/static are content-hashed by Next's build, so `immutable` is
    // safe — a deploy produces new filenames, never new content under an
    // existing one. Deliberately NOT covering /_next/data/*.json (Next
    // owns that) and NOT covering /api/* (each route sets its own policy;
    // /api/tts in particular already sends `private, max-age=86400,
    // immutable` which we must not override).
    return [
      {
        source: "/_next/static/:path*",
        headers: [
          {
            key: "Cache-Control",
            value: "public, max-age=31536000, immutable",
          },
        ],
      },
      {
        // Favicons and apple-touch-icon: not hashed, but rarely change.
        // One-day cache balances staleness on rebrand against the per-nav
        // revalidation cost.
        source: "/:file(favicon.ico|apple-touch-icon.png|icon.png|icon.svg|apple-icon.png)",
        headers: [
          {
            key: "Cache-Control",
            value: "public, max-age=86400",
          },
        ],
      },
    ];
  },
};

export default nextConfig;
