"use client";

// Root-level error boundary. Triggered when an error escapes the root
// layout itself (e.g. during font loading, RumInit mount, etc.). At
// this scope we render our own <html> + <body> because the root layout
// is the thing that crashed.
//
// We can't reach `usePathname` here because the layout it lives in
// failed; we send the URL directly off window.location.

import { useEffect } from "react";

import { rum } from "@/lib/rum";

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    rum.error(error, {
      route:
        typeof window !== "undefined" ? window.location.pathname : "unknown",
      source: "global-error",
    });
  }, [error]);

  return (
    <html lang="en">
      <body
        style={{
          fontFamily: "system-ui, sans-serif",
          maxWidth: "32rem",
          margin: "4rem auto",
          padding: "0 1.5rem",
          lineHeight: 1.5,
        }}
      >
        <h1 style={{ fontSize: "1.5rem", fontWeight: 600 }}>
          tts.raizhost.com is broken
        </h1>
        <p style={{ marginTop: "0.75rem", color: "#666" }}>
          The page failed to load. Telemetry has captured the error.
        </p>
        {error.digest ? (
          <p
            style={{
              marginTop: "0.75rem",
              fontFamily: "ui-monospace, monospace",
              fontSize: "0.75rem",
              color: "#999",
            }}
          >
            ref: {error.digest}
          </p>
        ) : null}
        <div style={{ marginTop: "2rem" }}>
          <button
            type="button"
            onClick={reset}
            style={{
              padding: "0.5rem 1rem",
              borderRadius: "0.375rem",
              border: "1px solid #ccc",
              background: "#fff",
              cursor: "pointer",
              fontSize: "0.875rem",
            }}
          >
            Try again
          </button>
        </div>
      </body>
    </html>
  );
}
