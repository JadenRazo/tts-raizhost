"use client";

// Layout-level client component that mounts the RUM machinery once per
// page-load:
//   1. Web Vitals (LCP/INP/CLS/FCP/TTFB) for ALL routes — not just the
//      reader. Each metric carries the current route as a label.
//   2. Global JS error capture — window.onerror + unhandledrejection.
//   3. W3C trace context — minted on mount, refreshed on every soft
//      navigation. Every rum.event() and tracedFetch() under the same
//      route share one traceId.
//
// Returns null — no DOM. Mount it from app/layout.tsx exactly once.

import { useEffect, useRef } from "react";
import { usePathname } from "next/navigation";

import { rum } from "@/lib/rum";
import { newTraceContext } from "@/lib/trace-context";

const ROUTE_TEMPLATES: Array<[RegExp, string]> = [
  [/^\/$/, "/"],
  [/^\/login$/, "/login"],
  [/^\/signup$/, "/signup"],
  [/^\/upload$/, "/upload"],
  [/^\/recover$/, "/recover"],
  [/^\/read\/[^/]+$/, "/read/[bookId]"],
  [/^\/enroll\/[^/]+$/, "/enroll/[token]"],
];
function templateOf(pathname: string): string {
  for (const [rx, t] of ROUTE_TEMPLATES) {
    if (rx.test(pathname)) return t;
  }
  return "other";
}

export function RumInit() {
  const pathname = usePathname();
  const route = templateOf(pathname);

  // Hold the latest route in a ref so the web-vitals callbacks (which
  // close over the value at registration time) can read the current one
  // when the metric finally fires (LCP/CLS may fire seconds after first
  // paint, after a soft nav has already moved on).
  const routeRef = useRef(route);
  useEffect(() => {
    routeRef.current = route;
  }, [route]);

  // Mint a fresh trace context on every route change. The first event
  // of the new page (and every fetch under it) inherit it; the
  // server-side OTel auto-instrumentation parents real spans on this
  // traceId, making the dashboard → Tempo drilldown work.
  useEffect(() => {
    newTraceContext();
  }, [route]);

  // Web Vitals — registered ONCE on first mount. Each metric callback
  // reads the current route via routeRef. Web Vitals fire at most once
  // per page-load for time vitals; CLS keeps reporting throughout.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const wv = await import("web-vitals");
        if (cancelled) return;
        const handle = (m: { name: string; value: number; rating?: string }) =>
          rum.vital(m, routeRef.current);
        wv.onLCP(handle);
        wv.onINP(handle);
        wv.onCLS(handle);
        wv.onFCP(handle);
        wv.onTTFB(handle);
      } catch {
        // web-vitals is a small chunk; if its load fails we just lose
        // the vitals stream. No-op rather than break the page.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Global error capture. The 'error' event fires for any uncaught
  // exception thrown synchronously in the document; 'unhandledrejection'
  // fires for any Promise that rejects without a .catch. Both bubble
  // into rum.error() which sanitizes + emits a js_error event.
  useEffect(() => {
    const onError = (ev: ErrorEvent) => {
      const e =
        ev.error instanceof Error
          ? ev.error
          : new Error(ev.message || "unknown error");
      rum.error(e, { route: routeRef.current, source: "window.error" });
    };
    const onRejection = (ev: PromiseRejectionEvent) => {
      const reason =
        ev.reason instanceof Error
          ? ev.reason
          : new Error(typeof ev.reason === "string" ? ev.reason : "unhandled rejection");
      rum.error(reason, {
        route: routeRef.current,
        source: "unhandledrejection",
      });
    };
    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onRejection);
    return () => {
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onRejection);
    };
  }, []);

  return null;
}
